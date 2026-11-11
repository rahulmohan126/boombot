import type { Client } from 'discord.js';
import type { BoomBot } from '../bot.js';
import { commands } from '../commands/index.js';
import { getLogger } from '../logger.js';

const log = getLogger('events');

export async function onReady(bot: BoomBot, client: Client<true>): Promise<void> {
  for (const guild of client.guilds.cache.values()) bot.guilds.ensure(guild.id);
  bot.updatePresence();

  await client.application.commands.set(commands.map((command) => command.data.toJSON()));
  log.info({ count: commands.length }, 'Commands registered');

  for (const guild of client.guilds.cache.values()) {
    log.debug({ guildId: guild.id, guild: guild.name }, 'Active server');
  }
  log.info(
    { guilds: client.guilds.cache.size, startupMs: Date.now() - bot.startedAt },
    `Ready to begin! Serving in ${client.guilds.cache.size} servers`,
  );
}
