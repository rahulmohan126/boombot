import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackMonitor, type PlaybackSample } from '../src/music/PlaybackMonitor.js';

function sample(overrides: Partial<PlaybackSample> = {}): PlaybackSample {
  return {
    playing: true,
    playedMs: 0,
    playerMs: 0,
    missedFrames: 0,
    sourceBuffered: 1000,
    packetsBuffered: 10,
    sourceEnded: false,
    playerStatus: 'playing',
    voiceStatus: 'ready',
    pingWs: 20,
    pingUdp: 10,
    ...overrides,
  };
}

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('PlaybackMonitor', () => {
  let current: PlaybackSample;
  let log: ReturnType<typeof fakeLogger>;
  let monitor: PlaybackMonitor;

  /** Advances 5s of wall time during which the player consumed `playedMs` of audio */
  function tick(playedMs: number, overrides: Partial<PlaybackSample> = {}) {
    current = sample({
      ...overrides,
      playedMs: current.playedMs + playedMs,
      playerMs: current.playerMs + (overrides.playerMs ?? playedMs),
    });
    vi.advanceTimersByTime(5000);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    current = sample();
    log = fakeLogger();
    monitor = new PlaybackMonitor(
      log as never,
      () => current,
      60_000,
      5000,
      () => Date.now(),
    );
    // First tick only establishes a baseline
    vi.advanceTimersByTime(5000);
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it('reports healthy real-time playback at debug', () => {
    tick(5000);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenLastCalledWith(
      expect.objectContaining({ speed: 1 }),
      'Playback health',
    );
  });

  it('warns when audio is consumed faster than real time', () => {
    tick(9000);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ speed: 1.8 }),
      'Audio is being sent faster than real time',
    );
  });

  it('warns when audio is consumed slower than real time', () => {
    tick(2000, { playerMs: 5000 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ speed: 0.4, silenceMs: 3000 }),
      'Audio is being sent slower than real time',
    );
  });

  it('warns about silence even when overall speed looks right', () => {
    tick(4900, { playerMs: 5000 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ silenceMs: 100 }),
      'Player sent silence because it had no audio ready',
    );
  });

  it('warns when the buffer is empty while the source is running', () => {
    tick(5000, { packetsBuffered: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'Audio buffer is empty while the source is still running',
    );
  });

  it('ignores paused time', () => {
    tick(0, { playing: false, playerStatus: 'paused' });
    tick(0, { playing: false, playerStatus: 'paused' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('summarises the track', () => {
    tick(5000);
    tick(9000);
    const summary = monitor.stop();
    expect(summary).toMatchObject({
      samples: 2,
      fastSamples: 1,
      expectedMs: 60_000,
      playedMs: 14_000,
      wallMs: 10_000,
      speed: 1.4,
    });
  });
});
