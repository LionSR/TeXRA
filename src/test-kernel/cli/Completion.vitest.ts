import { beforeAll, describe, expect, it } from 'vitest';

import { rootCommand } from '@cli/commands/root';
import { generateCompletionScript } from '@cli/runtime/completion';
import { bashCompletion } from '@cli/runtime/completionBash';
import {
  collectCommands,
  type CompletionCommand,
} from '@cli/runtime/completionCommandTree';

/** Resolve one command by its space-joined path. A path that no longer exists
 *  is a broken test, not a command that offers no flags, so this throws rather
 *  than letting the `not.toContain` assertions below pass on `undefined`. */
function commandAt(
  commands: readonly CompletionCommand[],
  path: string,
): CompletionCommand {
  const command = commands.find(
    (candidate) => candidate.path.join(' ') === path,
  );
  if (!command) throw new Error(`no completion command at path "${path}"`);
  return command;
}

describe('CLI shell completion', () => {
  let bash: string;

  beforeAll(async () => {
    bash = await generateCompletionScript(rootCommand, 'bash');
  });

  it('consumes every bash value flag while resolving command paths', async () => {
    const commands = await collectCommands(rootCommand);
    const lines = bash.split('\n');
    const valueSkipIndex = lines.findIndex((line) =>
      line.includes('((i+=2)); continue'),
    );
    const pathValueLine =
      valueSkipIndex > 0 ? lines[valueSkipIndex - 1] : undefined;
    const valueFlags = new Set(
      commands.flatMap((command) =>
        command.flags.flatMap((flag) =>
          flag.takesValue
            ? [`--${flag.name}`, ...flag.aliases.map((alias) => `-${alias}`)]
            : [],
        ),
      ),
    );

    expect(pathValueLine).toBeDefined();
    for (const flag of valueFlags) {
      expect(pathValueLine).toContain(flag);
    }
  });

  it('keeps bash completion syntactically valid without value flags', () => {
    const bash = bashCompletion([
      {
        path: [],
        description: '',
        subcommands: [],
        flags: [],
      },
    ]);

    expect(bash).toContain('--_texra_no_value_flags_)');
  });

  it('does not offer headless-only flags on interactive commands', async () => {
    const commands = await collectCommands(rootCommand);
    const flagsFor = (path: string) =>
      commandAt(commands, path).flags.map((flag) => flag.name);

    expect(flagsFor('chat')).not.toContain('print');
    expect(flagsFor('chat')).not.toContain('output-format');
    expect(flagsFor('run')).toContain('print');
    expect(flagsFor('run')).toContain('output-format');
    expect(flagsFor('team run')).toContain('instruction-file');
  });
});
