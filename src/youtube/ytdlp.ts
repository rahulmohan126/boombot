import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { YT_DLP_COOKIES_PATH, type Cookies } from '../config.js';
import { getLogger, sanitize } from '../logger.js';

const log = getLogger('ytdlp');

/** yt-dlp executable, overridable for installs outside PATH */
const DEFAULT_BINARY = process.env.YT_DLP_PATH || 'yt-dlp';
/** Buffer up to 10 MiB of audio ahead of playback */
const HIGH_WATER_MARK = 10 * (1 << 20);
/** How often to log download throughput and buffer fill while streaming */
const STATS_INTERVAL_MS = 10_000;
/** Keep this much of yt-dlp's stderr for error messages */
const STDERR_LIMIT = 2000;

export interface YtDlpOptions {
  /** Netscape-format cookie file, if any */
  cookieFile?: string | null;
  proxy?: string | null;
  /** yt-dlp executable name or path */
  binary?: string;
}

export class YtDlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YtDlpError';
  }
}

/**
 * Streams a video's best audio through yt-dlp. Resolves once audio starts arriving,
 * and rejects if yt-dlp can't be started or exits before producing any.
 * Destroying the returned stream stops yt-dlp.
 */
export function streamAudio(
  videoId: string,
  { cookieFile, proxy, binary = DEFAULT_BINARY }: YtDlpOptions = {},
): Promise<Readable> {
  const args = [
    // Messages go to stderr when writing audio to stdout; they're logged, not shown
    '--no-progress',
    '--no-playlist',
    // YouTube's signature challenges need a JS runtime; yt-dlp only enables deno by default.
    // Without one, most formats are hidden and it fails with "Requested format is not available".
    '--js-runtimes',
    'node',
    '--remote-components',
    'ejs:github',
    '-f',
    'bestaudio[acodec=opus]/bestaudio/best',
    '-o',
    '-',
  ];
  if (proxy) args.push('--proxy', proxy);
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push('--', `https://www.youtube.com/watch?v=${videoId}`);

  log.debug({ videoId, args: args.map((arg) => sanitize(arg)) }, 'Starting yt-dlp');

  return new Promise((resolve, reject) => {
    const output = new PassThrough({ highWaterMark: HIGH_WATER_MARK });
    const spawnedAt = Date.now();
    let bytes = 0;
    let firstByteMs: number | null = null;
    let lastStats = { at: spawnedAt, bytes: 0 };
    let format: string | null = null;

    // A download well ahead of playback fills the buffer; one that can't keep up leaves it empty
    const statsTimer = setInterval(() => {
      const now = Date.now();
      const kbps = ((bytes - lastStats.bytes) / 1024 / ((now - lastStats.at) / 1000)) | 0;
      lastStats = { at: now, bytes };
      log.debug(
        {
          videoId,
          format,
          bytes,
          kbps,
          buffered: output.readableLength,
          bufferFull: output.readableLength >= HIGH_WATER_MARK,
        },
        'Download progress',
      );
    }, STATS_INTERVAL_MS);
    statsTimer.unref();
    const stopStats = () => clearInterval(statsTimer);
    const failToStart = (err: Error) => {
      stopStats();
      log.error({ err, binary }, 'Could not run yt-dlp');
      output.destroy();
      reject(new YtDlpError(`Could not run ${binary}: ${err.message}`));
    };

    let child;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // Some lookup failures (e.g. ENOTDIR from a PATH entry that's a file) throw synchronously
      failToStart(err as Error);
      return;
    }
    child.once('error', failToStart);

    // Ended on exit instead, so a failed exit can still error the stream
    child.stdout.pipe(output, { end: false });
    output.once('close', () => {
      stopStats();
      log.debug(
        { videoId, bytes, elapsedMs: Date.now() - spawnedAt, buffered: output.readableLength },
        'Audio stream closed',
      );
      child.kill();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    let partialLine = '';
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);

      const lines = (partialLine + chunk).split(/\r?\n/);
      partialLine = lines.pop() ?? '';
      for (const raw of lines) {
        const line = sanitize(raw.trim());
        if (!line) continue;
        format ??= /Downloading \d+ format\(s\): (\S+)/.exec(line)?.[1] ?? null;
        if (line.startsWith('ERROR')) log.error({ videoId, line }, 'yt-dlp reported an error');
        else if (line.startsWith('WARNING')) log.warn({ videoId, line }, 'yt-dlp warning');
        else log.debug({ videoId, line }, 'yt-dlp');
      }
    });

    let started = false;
    child.stdout.once('data', () => {
      started = true;
      firstByteMs = Date.now() - spawnedAt;
      log.info({ videoId, pid: child.pid, format, firstByteMs }, 'yt-dlp is producing audio');
      resolve(output);
    });

    child.once('close', (code, signal) => {
      stopStats();
      log.debug(
        {
          videoId,
          code,
          signal,
          bytes,
          firstByteMs,
          elapsedMs: Date.now() - spawnedAt,
          // Audio still waiting in the buffer when the download finished
          buffered: output.readableLength,
          destroyed: output.destroyed,
        },
        'yt-dlp exited',
      );
      if (output.destroyed) return;
      if (code === 0 && started) {
        output.end();
        return;
      }

      const reason =
        code === 0 ? 'exited without producing audio' : `exited with ${code ?? signal}`;
      log.error(
        { videoId, code, signal, started, stderr: sanitize(stderr.trim()) },
        'yt-dlp failed',
      );
      const error = new YtDlpError(`yt-dlp ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      if (started) output.destroy(error);
      else {
        output.destroy();
        reject(error);
      }
    });
  });
}

/**
 * Writes cookies to a private file for yt-dlp and returns its path. It's a fixed path
 * overwritten on each start, so no copies pile up when the bot is killed without
 * cleaning up. Without cookies, a file left from an earlier run is removed.
 */
export function writeCookieFile(
  cookies: Cookies | null,
  file = YT_DLP_COOKIES_PATH,
): string | null {
  if (!cookies?.length) {
    rmSync(file, { force: true });
    return null;
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, toNetscapeCookies(cookies), { mode: 0o600 });
  return file;
}

/**
 * Converts cookies to the Netscape cookie file format yt-dlp reads
 */
export function toNetscapeCookies(cookies: Cookies): string {
  const lines = cookies.map((cookie) => {
    const domain = typeof cookie.domain === 'string' ? cookie.domain : '.youtube.com';
    const path = typeof cookie.path === 'string' ? cookie.path : '/';
    const secure = cookie.secure === false ? 'FALSE' : 'TRUE';
    const expires =
      typeof cookie.expirationDate === 'number' ? Math.floor(cookie.expirationDate) : 0;
    const subdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    return [domain, subdomains, path, secure, expires, cookie.name, cookie.value].join('\t');
  });

  return ['# Netscape HTTP Cookie File', ...lines, ''].join('\n');
}
