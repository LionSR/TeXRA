import {
  editDistance,
  typoSuggestionThreshold,
} from '@utils/text/editDistance';

import { commandSubCommands, type AnyCommand } from './commandTree';
import { knownGlobalFlagTokenCount } from './argTokens';

export interface UnknownCliCommand {
  readonly typedCommand: string;
  readonly helpCommand: string;
  readonly suggestedCommand?: string;
}

function isPureSubCommandContainer(
  cmd: AnyCommand,
  subCommands: Record<string, AnyCommand>,
): boolean {
  return (
    Object.keys(subCommands).length > 0 &&
    typeof (cmd as { run?: unknown }).run !== 'function'
  );
}

function suggestSubCommand(
  token: string,
  subCommands: Record<string, AnyCommand>,
): string | undefined {
  let best: { readonly name: string; readonly distance: number } | undefined;

  for (const name of Object.keys(subCommands)) {
    const distance = editDistance(token, name);
    if (distance > typoSuggestionThreshold(token, name)) continue;
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && name < best.name)
    ) {
      best = { name, distance };
    }
  }

  return best?.name;
}

export async function detectUnknownCliCommand(
  rootCommand: AnyCommand,
  rawArgs: readonly string[],
): Promise<UnknownCliCommand | undefined> {
  let cmd = rootCommand;
  const pathParts = ['texra'];

  for (let i = 0; i < rawArgs.length;) {
    const token = rawArgs[i];
    if (token === undefined || token === '--') break;

    if (token.startsWith('-')) {
      const tokenCount = knownGlobalFlagTokenCount(rawArgs, i);
      if (tokenCount === undefined) return undefined;
      i += tokenCount;
      continue;
    }

    const subCommands = await commandSubCommands(cmd);
    if (!subCommands) return undefined;

    const next = subCommands[token];
    if (next) {
      cmd = next;
      pathParts.push(token);
      i += 1;
      continue;
    }

    if (isPureSubCommandContainer(cmd, subCommands)) {
      const suggestedName = suggestSubCommand(token, subCommands);
      return {
        typedCommand: [...pathParts, token].join(' '),
        helpCommand: pathParts.join(' '),
        suggestedCommand:
          suggestedName == null
            ? undefined
            : [...pathParts, suggestedName].join(' '),
      };
    }

    return undefined;
  }

  return undefined;
}

export function formatUnknownCliCommand(command: UnknownCliCommand): string {
  const suggestion =
    command.suggestedCommand == null
      ? ''
      : ` Did you mean \`${command.suggestedCommand}\`?`;
  return `Unknown command: ${command.typedCommand}.${suggestion} Run \`${command.helpCommand} --help\` for usage.`;
}
