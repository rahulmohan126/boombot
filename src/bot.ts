import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';
import { GUILD_DATA_PATH, type Config } from './config.js';
import { onGuildCreate } from './events/guildCreate.js';
import { onInteractionCreate } from './events/interactionCreate.js';
import { onReady } from './events/ready.js';
import { onVoiceStateUpdate } from './events/voiceStateUpdate.js';
import { GuildStore } from './guilds/GuildStore.js';
import { flushLogger, getLogger } from './logger.js';
import { MusicQueue } from './music/MusicQueue.js';
import { QueueManager } from './music/QueueManager.js';
import { card, notice } from './ui/embeds.js';
import { YouTubeService } from './youtube/YouTubeService.js';

const log = getLogger('bot');

/**
 * Composition root: owns the Discord client and the bot's services
 */
export class BoomBot {
  readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  readonly youtube: YouTubeService;
  readonly guilds: GuildStore;
  readonly queues: QueueManager;

  constructor(
    readonly config: Config,
    readonly startedAt = Date.now(),
  ) {
    this.youtube = new YouTubeService(config.cookies, config.proxy);
    this.guilds = new GuildStore(GUILD_DATA_PATH, config.defaultPrefix);
    this.queues = new QueueManager((guildId) => this.#createQueue(guildId));
  }

  async start(): Promise<void> {
    await this.guilds.load();
    this.#registerEvents();
    // Create the YouTube client up front so the first /play is fast
    this.youtube
      .client()
      .then(() => log.debug('YouTube client ready'))
      .catch((err: unknown) => log.error({ err }, 'Failed to create YouTube client'));
    log.info('Logging in to Discord');
    await this.client.login(this.config.token);
  }

  async shutdown(): Promise<void> {
    log.info('Stopping queues');
    this.queues.stopAll();
    await this.client.destroy();
    await this.guilds.save();
    log.info('Shutdown complete');
    flushLogger();
  }

  updatePresence(): void {
    const count = this.client.guilds.cache.size;
    this.client.user?.setActivity({
      name: 'Custom Status',
      type: ActivityType.Custom,
      state: `Connected to ${count} ${count === 1 ? 'server' : 'servers'}...`,
    });
  }

  #createQueue(guildId: string): MusicQueue {
    const queue = new MusicQueue(guildId, this.youtube);

    queue.on('trackStart', (track) => {
      queue.textChannel
        ?.send(
          card({
            header: 'Started playing',
            body: `🎶 [**${track.title}**](${track.url})`,
            tone: 'success',
            member: track.requestedBy,
          }),
        )
        .catch((err: unknown) => log.error({ err, guildId }, 'Failed to announce track'));
    });

    queue.on('trackError', (track, err) => {
      log.error({ err, guildId, url: track.url }, 'Track failed to play');
      queue.textChannel
        ?.send(
          notice(
            `Sorry, there was an error processing "${track.title}", moving to the next song in the queue`,
            'error',
          ),
        )
        .catch((sendErr: unknown) =>
          log.error({ err: sendErr, guildId }, 'Failed to send error notice'),
        );
    });

    return queue;
  }

  #registerEvents(): void {
    const handle =
      <Args extends unknown[]>(
        name: string,
        handler: (bot: BoomBot, ...args: Args) => Promise<void>,
      ) =>
      (...args: Args) => {
        handler(this, ...args).catch((err: unknown) =>
          log.error({ err }, `Error in ${name} handler`),
        );
      };

    this.client.once(Events.ClientReady, handle('ready', onReady));
    this.client.on(Events.InteractionCreate, handle('interactionCreate', onInteractionCreate));
    this.client.on(Events.VoiceStateUpdate, handle('voiceStateUpdate', onVoiceStateUpdate));
    this.client.on(Events.GuildCreate, handle('guildCreate', onGuildCreate));
    this.client.on(Events.Error, (err) => log.error({ err }, 'Client error'));
    this.client.on(Events.Warn, (message) => log.warn(message));
    this.client.on(Events.Debug, (message) => log.trace(message));
    this.client.on(Events.ShardDisconnect, (event, shardId) =>
      log.warn({ code: event.code, shardId }, 'Shard disconnected'),
    );
    this.client.on(Events.ShardReconnecting, (shardId) =>
      log.info({ shardId }, 'Shard reconnecting'),
    );
    this.client.on(Events.ShardResume, (shardId, replayed) =>
      log.info({ shardId, replayed }, 'Shard resumed'),
    );
  }
}
