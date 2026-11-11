import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushLogger, getLogger, initLogger, parseLevel, sanitize } from '../src/logger.js';

describe('parseLevel', () => {
  it('accepts known levels case-insensitively and rejects others', () => {
    expect(parseLevel('DEBUG')).toBe('debug');
    expect(parseLevel(' warn ')).toBe('warn');
    expect(parseLevel('loud')).toBeUndefined();
    expect(parseLevel(null)).toBeUndefined();
  });
});

describe('sanitize', () => {
  it('hides proxy credentials', () => {
    expect(sanitize('http://user:secret@proxy.example:8080')).toBe(
      'http://***:***@proxy.example:8080',
    );
    expect(sanitize('http://proxy.example:8080')).toBe('http://proxy.example:8080');
  });

  it('hides bot tokens', () => {
    const token = `${'A'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(30)}`;
    expect(sanitize(`login ${token} failed`)).toBe('login [token] failed');
  });
});

describe('file logging', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'boombot-logs-'));
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await initLogger({ level: 'silent' });
    await rm(dir, { recursive: true, force: true });
  });

  it('writes JSON lines with bindings, honouring the file level', async () => {
    await initLogger({ level: 'silent', fileLevel: 'info', dir });
    const log = getLogger('music', { guildId: '42' });
    log.debug('too quiet');
    log.info({ track: 'Song' }, 'Track started');
    log.error({ err: new Error('boom') }, 'Failed');
    flushLogger();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const [file] = await readdir(dir);
    expect(file).toMatch(/^boombot\.\d{4}-\d{2}-\d{2}\.\d+\.log$/);
    const lines = (await readFile(join(dir, file!), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.map((line) => line.msg)).toEqual(['Track started', 'Failed']);
    expect(lines[0]).toMatchObject({
      level: 'info',
      module: 'music',
      guildId: '42',
      track: 'Song',
    });
    expect(lines[1]).toMatchObject({ level: 'error' });
    expect(JSON.stringify(lines[1])).toContain('boom');
  });

  it('redacts sensitive fields', async () => {
    await initLogger({ level: 'silent', fileLevel: 'info', dir });
    getLogger('x').info({ token: 'secret', proxy: 'http://u:p@h' }, 'hello');
    flushLogger();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const [file] = await readdir(dir);
    const text = await readFile(join(dir, file!), 'utf8');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('u:p@h');
  });
});
