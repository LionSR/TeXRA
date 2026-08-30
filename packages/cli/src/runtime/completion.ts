import { bashCompletion } from './completionBash';
import {
  collectCommands,
  type AnyCommand,
  type CliCompletionShell,
} from './completionCommandTree';
import { fishCompletion } from './completionFish';
import { zshCompletion } from './completionZsh';

export async function generateCompletionScript(
  rootCommand: AnyCommand,
  shell: CliCompletionShell,
): Promise<string> {
  const commands = await collectCommands(rootCommand);
  switch (shell) {
    case 'bash':
      return bashCompletion(commands);
    case 'zsh':
      return zshCompletion(commands);
    case 'fish':
      return fishCompletion(commands);
  }
}
