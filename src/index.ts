import { BoomBot } from './bot.js';
import { LOG_DIR, loadConfig } from './config.js';
import { flushLogger, getLogger, initLogger, parseLevel } from './logger.js';

const startedAt = Date.now();
const log = getLogger('main');

/** Logs a fatal error, makes sure it reaches the log files, then exits */
function die(err: unknown, message: string): never {
  log.fatal({ err }, message);
  flushLogger();
  process.exit(1);
}

process.on('unhandledRejection', (reason) => die(reason, 'Unhandled promise rejection'));
process.on('uncaughtException', (err) => die(err, 'Uncaught exception'));

try {
  const config = await loadConfig();
  await initLogger({
    level: parseLevel(config.logLevel),
    fileLevel: parseLevel(config.logFileLevel),
    dir: LOG_DIR,
  });
  log.info({ node: process.version, logDir: LOG_DIR }, 'Starting boombot');

  const bot = new BoomBot(config, startedAt);

  const shutdown = (signal: string) => {
    log.info({ signal }, 'Shutting down');
    bot.shutdown().then(
      () => process.exit(0),
      (err: unknown) => die(err, 'Error during shutdown'),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await bot.start();
} catch (err) {
  die(err, 'Failed to start');
}
