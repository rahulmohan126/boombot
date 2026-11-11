import type { Logger } from 'pino';

/** What the monitor reads from the player on every tick */
export interface PlaybackSample {
  /** Audio is actually being sent (not paused, buffering or idle) */
  playing: boolean;
  /** Track audio consumed so far, in ms of playback time */
  playedMs: number;
  /** Time the player has run, including silence it sent while it had no audio ready */
  playerMs: number;
  /** Frames in a row the player wanted to send but had no audio for, right now */
  missedFrames: number;
  /** Audio waiting in the stream feeding the player (bytes) */
  sourceBuffered: number;
  /** Decoded packets waiting to be sent */
  packetsBuffered: number;
  /** The source has no more data coming */
  sourceEnded: boolean;
  playerStatus: string;
  voiceStatus: string | null;
  pingWs: number | null;
  pingUdp: number | null;
}

export interface PlaybackSummary {
  wallMs: number;
  playedMs: number;
  expectedMs: number;
  speed: number | null;
  samples: number;
  fastSamples: number;
  slowSamples: number;
  starvedSamples: number;
  /** Silence sent in place of audio the player didn't have ready */
  silenceMs: number;
}

/** Playback speed outside this range of 1.0 is reported as a problem */
const SPEED_TOLERANCE = 0.1;
export const MONITOR_INTERVAL_MS = 5_000;

/**
 * Watches one track's playback and logs whether it is progressing in real time. Audio sent
 * faster or slower than the wall clock (the "sped up" symptom), frames the player had to skip
 * for lack of data, and empty buffers all show up here with the numbers needed to explain them.
 */
export class PlaybackMonitor {
  readonly #timer: NodeJS.Timeout;
  /** Wall time spent in the playing state, used for the overall speed */
  #playingWallMs = 0;
  /** Playback time sent over the same stretches, for comparing against the wall time */
  #playingPlayedMs = 0;
  #silenceMs = 0;
  #last: { at: number; sample: PlaybackSample } | null = null;
  #latest: PlaybackSample | null = null;
  #summary = { samples: 0, fast: 0, slow: 0, starved: 0 };
  #stopped = false;

  constructor(
    private readonly log: Logger,
    private readonly read: () => PlaybackSample,
    private readonly expectedMs: number,
    intervalMs = MONITOR_INTERVAL_MS,
    private readonly now = Date.now,
  ) {
    this.#timer = setInterval(() => this.#tick(), intervalMs);
    this.#timer.unref();
  }

  #tick(): void {
    const at = this.now();
    const sample = this.read();
    this.#latest = sample;
    const last = this.#last;
    this.#last = { at, sample };
    // Nothing to compare against until two samples were taken while playing
    if (!last || !sample.playing || !last.sample.playing) {
      this.log.debug({ ...describe(sample) }, 'Playback not in progress');
      return;
    }

    const wallMs = at - last.at;
    if (wallMs <= 0) return;
    const playedMs = sample.playedMs - last.sample.playedMs;
    const silenceMs =
      sample.playerMs - sample.playedMs - (last.sample.playerMs - last.sample.playedMs);
    const speed = playedMs / wallMs;
    const starved = sample.packetsBuffered === 0 && !sample.sourceEnded;

    this.#playingWallMs += wallMs;
    this.#playingPlayedMs += playedMs;
    this.#silenceMs += silenceMs;
    this.#summary.samples++;
    const fields = { ...describe(sample), wallMs, playedMs, speed: round(speed), silenceMs };

    if (speed > 1 + SPEED_TOLERANCE) {
      this.#summary.fast++;
      this.log.warn(fields, 'Audio is being sent faster than real time');
    } else if (speed < 1 - SPEED_TOLERANCE) {
      this.#summary.slow++;
      this.log.warn(fields, 'Audio is being sent slower than real time');
    } else if (silenceMs >= 40) {
      this.log.warn(fields, 'Player sent silence because it had no audio ready');
    } else if (starved) {
      this.log.warn(fields, 'Audio buffer is empty while the source is still running');
    } else {
      this.log.debug(fields, 'Playback health');
    }
    if (starved) this.#summary.starved++;
  }

  /**
   * Stops monitoring and returns totals for the track
   */
  stop(): PlaybackSummary {
    if (!this.#stopped) {
      try {
        this.#latest = this.read();
      } catch {
        // The player may already be gone; the last tick's numbers will do
      }
    }
    const summary: PlaybackSummary = {
      wallMs: this.#playingWallMs,
      playedMs: this.#latest?.playedMs ?? 0,
      expectedMs: this.expectedMs,
      speed: this.#playingWallMs > 0 ? round(this.#playingPlayedMs / this.#playingWallMs) : null,
      samples: this.#summary.samples,
      fastSamples: this.#summary.fast,
      slowSamples: this.#summary.slow,
      starvedSamples: this.#summary.starved,
      silenceMs: this.#silenceMs,
    };
    if (this.#stopped) return summary;
    this.#stopped = true;
    clearInterval(this.#timer);
    return summary;
  }
}

function describe(sample: PlaybackSample) {
  return {
    playerStatus: sample.playerStatus,
    voiceStatus: sample.voiceStatus,
    playedMs: sample.playedMs,
    playerMs: sample.playerMs,
    missedFrames: sample.missedFrames,
    sourceBuffered: sample.sourceBuffered,
    packetsBuffered: sample.packetsBuffered,
    sourceEnded: sample.sourceEnded,
    pingWs: sample.pingWs,
    pingUdp: sample.pingUdp,
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;
