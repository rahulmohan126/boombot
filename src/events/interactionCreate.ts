import type { Interaction } from 'discord.js';
import type { BoomBot } from '../bot.js';
import { commandsByName } from '../commands/index.js';
import type { CommandContext } from '../commands/types.js';
import { notice } from '../ui/embeds.js';
import { getLogger } from '../logger.js';

const log = getLogger('events');

export async function onInteractionCreate(bot: BoomBot, interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  const reply: CommandContext['reply'] = async (payload) => {
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
  };

  const ctx: CommandContext = {
    interaction,
    member: interaction.member,
    bot,
    settings: bot.guilds.ensure(interaction.guildId),
    queue: bot.queues.get(interaction.guildId),
    reply,
    notify: (text, tone) => reply(notice(text, tone)),
  };

  log.debug(
    { command: interaction.commandName, guildId: interaction.guildId, userId: interaction.user.id },
    'Command received',
  );

  try {
    for (const precondition of command.preconditions ?? []) {
      const error = precondition(ctx);
      if (error) {
        log.debug({ command: interaction.commandName, reason: error }, 'Command rejected');
        return await ctx.notify(error, 'error');
      }
    }
    await command.execute(ctx);
  } catch (err) {
    log.error(
      { err, command: interaction.commandName, guildId: interaction.guildId },
      `Error running /${interaction.commandName}`,
    );
    await ctx.notify('Something went wrong running that command.', 'error').catch(() => {});
  }
}
