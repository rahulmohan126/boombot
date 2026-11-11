import type { Guild } from 'discord.js';
import type { BoomBot } from '../bot.js';
import { getLogger } from '../logger.js';

const log = getLogger('events');

export function onGuildCreate(bot: BoomBot, guild: Guild): Promise<void> {
  bot.guilds.ensure(guild.id);
  bot.updatePresence();
  log.info({ guildId: guild.id, guild: guild.name, members: guild.memberCount }, 'Joined guild');
  return Promise.resolve();
}
