import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import type { SendableChannels, VoiceBasedChannel } from 'discord.js';
import { getLogger } from '../logger.js';
import { PlaybackMonitor, type PlaybackSample } from './PlaybackMonitor.js';
import type { AudioSource, AudioStream } from '../youtube/YouTubeService.js';
import type { Track } from './Track.js';

/** How long to stay in the voice channel after the queue runs out */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 5_000;

/** The next track's stream, loaded while the current one plays */
interface Prefetch {
  track: Track;
  load: Promise<AudioStream>;
  /** The stream errored before it was used */
  failed: boolean;
}

interface QueueEvents {
  trackStart: [track: Track];
  trackError: [track: Track, error: unknown];
}

/**
 * A guild's music session: voice connection, audio player and track queue.
 *
 * States: disconnected → connected + playing ⇄ connected + idle (auto-disconnects after
 * IDLE_TIMEOUT_MS) → disconnected.
 */
export class MusicQueue extends EventEmitter<QueueEvents> {
  textChannel: SendableChannels | null = null;
  #voiceChannelId: string | null = null;
  #connection: VoiceConnection | null = null;
  readonly #player: AudioPlayer;
  #resource: AudioResource<Track> | null = null;
  #stream: Readable | null = null;
  #prefetch: Prefetch | null = null;

  #tracks: Track[] = [];
  #current: Track | null = null;
  #looping = false;
  #paused = false;
  #skipping = false;
  /** Incremented on every track change so stale async loads can tell they were superseded */
  #generation = 0;
  #idleTimer: NodeJS.Timeout | null = null;
  #monitor: PlaybackMonitor | null = null;
  readonly #log;

  constructor(
    readonly guildId: string,
    private readonly audio: AudioSource,
    private readonly idleTimeoutMs = IDLE_TIMEOUT_MS,
  ) {
    super();
    this.#log = getLogger('music', { guildId });
    this.#player = createAudioPlayer();
    this.#player.on(AudioPlayerStatus.Idle, () => this.#onTrackFinished());
    this.#player.on('stateChange', (from, to) =>
      this.#log.debug({ from: from.status, to: to.status }, 'Audio player state changed'),
    );
    this.#player.on('debug', (message) => this.#log.trace(message));
    this.#player.on('error', (err) =>
      this.#log.error({ err, track: err.resource.metadata }, 'Audio player error'),
    );
  }

  get voiceChannelId(): string | null {
    return this.#voiceChannelId;
  }

  /** Connected to a voice channel (playing or waiting for more songs) */
  get isConnected(): boolean {
    return this.#connection !== null;
  }

  /** A track is playing (or paused/loading) */
  get isActive(): boolean {
    return this.#current !== null;
  }

  get current(): Track | null {
    return this.#current;
  }

  get upcoming(): readonly Track[] {
    return this.#tracks;
  }

  get looping(): boolean {
    return this.#looping;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Playback position of the current track */
  get positionMs(): number {
    return this.#resource?.playbackDuration ?? 0;
  }

  /** Remaining play time of the current track plus everything queued */
  get remainingMs(): number {
    const current = this.#current ? Math.max(0, this.#current.durationMs - this.positionMs) : 0;
    return this.#tracks.reduce((total, track) => total + track.durationMs, current);
  }

  /**
   * Joins a voice channel; songs are announced in the given text channel
   */
  async connect(
    voiceChannel: VoiceBasedChannel,
    textChannel: SendableChannels | null,
  ): Promise<void> {
    if (this.#connection) return;

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });
    this.#connection = connection;
    this.#voiceChannelId = voiceChannel.id;
    this.textChannel = textChannel;
    this.#log.info({ voiceChannelId: voiceChannel.id }, 'Joining voice channel');

    connection.on('debug', (message) => this.#log.trace(message));
    connection.on('stateChange', (from, to) =>
      this.#log.debug({ from: from.status, to: to.status }, 'Voice connection state changed'),
    );
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Moving channels briefly disconnects; only give up if it doesn't recover
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_TIMEOUT_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_TIMEOUT_MS),
      ]).catch(() => {
        this.#log.warn('Voice connection did not recover after disconnecting; leaving');
        if (this.#connection === connection) this.stop();
      });
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.#connection === connection) this.stop();
    });
    connection.on('error', (err) => {
      this.#log.error({ err }, 'Voice connection error');
      if (this.#connection === connection) this.stop();
    });
    connection.subscribe(this.#player);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    } catch (err) {
      this.#log.error({ err }, 'Voice connection did not become ready');
      if (this.#connection === connection) this.stop();
      throw err;
    }
  }

  /**
   * Adds tracks to the end of the queue, starting playback if nothing is playing
   */
  enqueue(...tracks: Track[]): void {
    this.#tracks.push(...tracks);
    this.#log.info(
      {
        added: tracks.length,
        titles: tracks.slice(0, 3).map((track) => track.title),
        queued: this.#tracks.length,
      },
      'Tracks enqueued',
    );
    if (!this.#current) void this.#playNext();
    else if (this.#resource) this.#startPrefetch();
  }

  /**
   * Removes the track at a (zero-based) queue position
   */
  remove(index: number): Track | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.#tracks.length) return null;
    const removed = this.#tracks.splice(index, 1)[0] ?? null;
    if (index === 0 && this.#resource) this.#startPrefetch();
    return removed;
  }

  /**
   * Skips the current track (also ends looping)
   */
  skip(): void {
    if (!this.#current) return;
    this.#log.info({ track: this.#current.title }, 'Skipping track');
    this.#looping = false;
    this.#skipping = true;
    this.#player.stop(true);
  }

  /** Toggles looping of the current track; returns the new state */
  toggleLoop(): boolean {
    this.#looping = !this.#looping;
    this.#log.info({ looping: this.#looping }, 'Loop toggled');
    return this.#looping;
  }

  /** Returns false if already paused */
  pause(): boolean {
    if (this.#paused) return false;
    this.#paused = true;
    this.#log.info('Paused');
    this.#player.pause();
    return true;
  }

  /** Returns false if already playing */
  resume(): boolean {
    if (!this.#paused) return false;
    this.#paused = false;
    this.#log.info('Resumed');
    this.#player.unpause();
    return true;
  }

  /**
   * Stops playback, clears the queue and leaves the voice channel
   */
  stop(): void {
    this.#log.info(
      { dropped: this.#tracks.length, current: this.#current?.title },
      'Stopping queue',
    );
    this.#generation++;
    this.#clearIdleTimer();

    const connection = this.#connection;
    this.#connection = null;
    this.#voiceChannelId = null;
    this.textChannel = null;

    this.#tracks = [];
    this.#current = null;
    this.#looping = false;
    this.#paused = false;
    this.#skipping = false;

    this.#player.stop(true);
    this.#releaseStream();
    this.#discardPrefetch();
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
  }

  async #playNext(): Promise<void> {
    const track = this.#tracks.shift();
    if (!track) {
      this.#log.info(
        { idleTimeoutMs: this.idleTimeoutMs },
        'Queue finished; waiting for more tracks',
      );
      this.#current = null;
      this.#releaseStream();
      this.#discardPrefetch();
      this.#startIdleTimer();
      return;
    }
    await this.#play(track);
  }

  async #play(track: Track): Promise<void> {
    this.#clearIdleTimer();
    this.#releaseStream();
    this.#current = track;
    this.#paused = false;
    const generation = ++this.#generation;

    let audio: AudioStream;
    try {
      audio = await this.#load(track);
    } catch (err) {
      if (generation !== this.#generation) return;
      this.#log.error({ err, track: track.title, id: track.id }, 'Failed to load track');
      this.#failTrack(track, err);
      await this.#playNext();
      return;
    }

    const { stream, type } = audio;
    // The queue was stopped or moved on while the stream was loading
    if (generation !== this.#generation || !this.#connection) {
      stream.destroy();
      return;
    }

    stream.on('error', (err) => {
      if (generation !== this.#generation) return;
      this.#log.error({ err, track: track.title, id: track.id }, 'Stream error during playback');
      this.#failTrack(track, err);
      this.#player.stop(true);
    });

    this.#stream = stream;
    const resource = createAudioResource(stream, { inputType: type, metadata: track });
    this.#resource = resource;
    this.#log.info(
      {
        track: track.title,
        id: track.id,
        inputType: type,
        // Anything other than a pass-through Opus type is decoded and re-encoded in this process
        transcoded: resource.edges?.length ? resource.edges.map((edge) => edge.type) : null,
        sourceBuffered: stream.readableLength,
        sourceHighWaterMark: stream.readableHighWaterMark,
      },
      'Creating audio resource',
    );
    stream.once('end', () => this.#log.debug({ id: track.id }, 'Source stream ended'));
    stream.once('close', () =>
      this.#log.debug({ id: track.id, buffered: stream.readableLength }, 'Source stream closed'),
    );
    resource.playStream.once('end', () =>
      this.#log.debug({ id: track.id, playedMs: resource.playbackDuration }, 'Audio fully read'),
    );
    resource.playStream.on('error', (err) =>
      this.#log.error({ err, id: track.id }, 'Audio pipeline error'),
    );
    this.#monitor = new PlaybackMonitor(
      this.#log,
      () => this.#samplePlayback(resource, stream),
      track.durationMs,
    );
    this.#player.play(resource);
    this.#log.info(
      { track: track.title, id: track.id, durationMs: track.durationMs },
      'Track started',
    );
    this.emit('trackStart', track);
    this.#startPrefetch();
  }

  /**
   * Gets a track's stream, using the prefetched one if it's still good
   */
  async #load(track: Track): Promise<AudioStream> {
    const prefetch = this.#prefetch;
    if (prefetch?.track !== track) return this.audio.stream(track.id);
    this.#log.debug({ id: track.id }, 'Using prefetched stream');

    this.#prefetch = null;
    try {
      const audio = await prefetch.load;
      if (!prefetch.failed) return audio;
      this.#log.warn({ id: track.id }, 'Prefetched stream errored; loading again');
      audio.stream.destroy();
    } catch (err) {
      // It may have failed on a passing problem long ago; try once more below
      this.#log.warn({ err, id: track.id }, 'Prefetch failed; loading again');
    }
    return this.audio.stream(track.id);
  }

  /**
   * Starts loading the next track, replacing a prefetch of a track that's no longer next
   */
  #startPrefetch(): void {
    const next = this.#tracks[0];
    if (this.#prefetch?.track === next) return;
    this.#discardPrefetch();
    if (!next) return;

    this.#log.debug({ id: next.id, track: next.title }, 'Prefetching next track');
    const prefetch: Prefetch = { track: next, load: this.audio.stream(next.id), failed: false };
    prefetch.load.then(
      ({ stream }) => {
        stream.on('error', (err) => {
          prefetch.failed = true;
          this.#log.warn({ err, id: next.id }, 'Prefetched stream errored');
        });
      },
      (err: unknown) => this.#log.warn({ err, id: next.id }, 'Prefetch failed'),
    );
    this.#prefetch = prefetch;
  }

  #discardPrefetch(): void {
    const prefetch = this.#prefetch;
    this.#prefetch = null;
    void prefetch?.load.then(
      ({ stream }) => stream.destroy(),
      () => {},
    );
  }

  #failTrack(track: Track, err: unknown): void {
    this.#looping = false;
    this.emit('trackError', track, err);
  }

  #onTrackFinished(): void {
    const finished = this.#current;
    if (!finished || this.#resource?.metadata !== finished) return;
    this.#endMonitor(this.#skipping ? 'skipped' : 'finished');
    this.#resource = null;
    this.#log.info({ track: finished.title }, 'Track finished');

    const replay = this.#looping && !this.#skipping;
    this.#skipping = false;
    void (replay ? this.#play(finished) : this.#playNext());
  }

  /** Reads everything the playback monitor needs from the player, resource and connection */
  #samplePlayback(resource: AudioResource<Track>, source: Readable): PlaybackSample {
    const state = this.#player.state;
    const playing = state.status === AudioPlayerStatus.Playing;
    const ping = this.#connection?.ping;
    return {
      playing,
      playedMs: resource.playbackDuration,
      playerMs: 'playbackDuration' in state ? state.playbackDuration : resource.playbackDuration,
      missedFrames: 'missedFrames' in state ? state.missedFrames : 0,
      sourceBuffered: source.readableLength,
      packetsBuffered: resource.playStream.readableLength,
      sourceEnded: source.readableEnded,
      playerStatus: state.status,
      voiceStatus: this.#connection?.state.status ?? null,
      pingWs: ping?.ws ?? null,
      pingUdp: ping?.udp ?? null,
    };
  }

  /** Stops the playback monitor and logs how the track went */
  #endMonitor(reason: string): void {
    const monitor = this.#monitor;
    this.#monitor = null;
    if (!monitor) return;
    const summary = monitor.stop();
    const track = this.#current;
    // Ending far short of the track's length points at a stream that cut out early
    const early = reason === 'finished' && summary.playedMs < summary.expectedMs * 0.9;
    const level = early || summary.silenceMs >= 100 || summary.starvedSamples > 0 ? 'warn' : 'info';
    this.#log[level](
      { track: track?.title, id: track?.id, reason, ...summary },
      'Playback summary',
    );
  }

  #releaseStream(): void {
    this.#endMonitor('released');
    this.#stream?.destroy();
    this.#stream = null;
    this.#resource = null;
  }

  #startIdleTimer(): void {
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => this.stop(), this.idleTimeoutMs);
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}
