import pino, { multistream, type DestinationStream, type Level, type Logger } from 'pino';
import pretty from 'pino-pretty';
import roll from 'pino-roll';

export type LogLevel = Level | 'silent';

export interface LoggerOptions {
  /** Minimum level written to stdout */
  level?: LogLevel;
  /** Minimum level written to the log files */
  fileLevel?: LogLevel;
  /** Directory for log files; files are skipped when omitted */
  dir?: string | null;
  /** Console output: human readable lines, or raw JSON */
  format?: 'pretty' | 'json';
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
const DEFAULT_LEVEL: LogLevel = 'info';
const DEFAULT_FILE_LEVEL: LogLevel = 'debug';
/** Rotate when a file passes this size, and at midnight */
const FILE_SIZE = '10m';
/** Keep this many rotated files */
const FILE_LIMIT = 14;

export function parseLevel(value: string | null | undefined): LogLevel | undefined {
  const level = value?.trim().toLowerCase();
  return LEVELS.find((candidate) => candidate === level);
}

/**
 * Hides secrets that would otherwise end up in logs: credentials embedded in proxy URLs
 * ("http://user:pass@host") and anything that looks like a bot token
 */
export function sanitize(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]*@/g, '$1***:***@')
    .replace(/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/g, '[token]');
}

/** Same as sanitize, for values that may not be a string */
export function sanitizeUrl(url: string | null | undefined): string | null {
  return url ? sanitize(url) : null;
}

const multi = multistream([]);

/**
 * The application logger. It can be used straight away (console only) and gains file output
 * once initLogger runs, so modules can create child loggers at import time.
 */
export const logger: Logger = pino(
  {
    // Each destination applies its own level
    level: 'trace',
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ['token', 'TOKEN', 'proxy', '*.token', '*.cookies', 'cookies', 'password'],
      censor: '[redacted]',
    },
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  },
  multi,
);

/**
 * Creates a logger for one area of the bot, e.g. getLogger('music', { guildId })
 */
export function getLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ module, ...bindings });
}

function consoleStream(format: 'pretty' | 'json'): DestinationStream {
  if (format === 'json') return pino.destination({ fd: 1, sync: true });
  return pretty({
    destination: 1,
    sync: true,
    colorize: Boolean(process.stdout.isTTY || process.env.FORCE_COLOR),
    singleLine: true,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname,module',
    messageFormat: (log, messageKey) => {
      const message = String(log[messageKey]);
      return typeof log.module === 'string' ? `[${log.module}] ${message}` : message;
    },
  });
}

function setStreams(streams: { stream: DestinationStream; level: LogLevel }[]): void {
  for (const entry of [...multi.streams]) multi.remove((entry as unknown as { id: number }).id);
  for (const { stream, level } of streams) multi.add({ stream, level: level as Level });
}

/**
 * Sets the console level and format, and starts writing rotated JSON log files.
 * Environment variables LOG_LEVEL, LOG_FILE_LEVEL and LOG_FORMAT take priority over options.
 */
export async function initLogger(options: LoggerOptions = {}): Promise<void> {
  const level = parseLevel(process.env.LOG_LEVEL) ?? options.level ?? DEFAULT_LEVEL;
  const fileLevel =
    parseLevel(process.env.LOG_FILE_LEVEL) ?? options.fileLevel ?? DEFAULT_FILE_LEVEL;
  const format =
    process.env.LOG_FORMAT === 'json' || process.env.LOG_FORMAT === 'pretty'
      ? process.env.LOG_FORMAT
      : (options.format ?? 'pretty');

  const streams = [{ stream: consoleStream(format), level }];
  if (options.dir) {
    try {
      const file = await roll({
        file: `${options.dir}/boombot`,
        extension: '.log',
        dateFormat: 'yyyy-MM-dd',
        frequency: 'daily',
        size: FILE_SIZE,
        limit: { count: FILE_LIMIT },
        mkdir: true,
      });
      // flushSync throws on a stream that is still opening its file
      await new Promise<void>((resolve, reject) => {
        file.once('ready', resolve);
        file.once('error', reject);
        if ((file as unknown as { fd: number }).fd >= 0) resolve();
      });
      streams.push({ stream: file, level: fileLevel });
    } catch (err) {
      setStreams(streams);
      logger.error({ err, dir: options.dir }, 'Could not open log file; logging to console only');
      return;
    }
  }
  setStreams(streams);
  logger.debug(
    { consoleLevel: level, fileLevel, format, dir: options.dir ?? null },
    'Logger initialised',
  );
}

/**
 * Writes anything still buffered; call before exiting
 */
export function flushLogger(): void {
  try {
    multi.flushSync();
  } catch {
    // A stream that can't be flushed (still opening, or closed) has nothing buffered to lose
  }
}

// Console only until initLogger runs. Silent under tests unless asked otherwise.
setStreams([
  {
    stream: consoleStream('pretty'),
    level: parseLevel(process.env.LOG_LEVEL) ?? (process.env.VITEST ? 'silent' : DEFAULT_LEVEL),
  },
]);
