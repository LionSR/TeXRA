import { describe, expect, it } from 'vitest';

import { rootCommand } from '@cli/commands/root';
import {
  CLI_COMPLETION_SHELLS,
  generateCompletionScript,
} from '@cli/runtime/completion';
import { collectCommands } from '@cli/runtime/completionCommandTree';

describe('CLI shell completion', () => {
  for (const shell of CLI_COMPLETION_SHELLS) {
    it(`generates ${shell} completion`, async () => {
      const script = await generateCompletionScript(rootCommand, shell);

      expect(script).toMatchSnapshot();
    });
  }

  it('keeps dynamic completion gated by TEXRA_COMPLETION_DYNAMIC', async () => {
    const bash = await generateCompletionScript(rootCommand, 'bash');

    expect(bash).toContain('TEXRA_COMPLETION_DYNAMIC');
    expect(bash).toContain('texra agents list --quiet');
    expect(bash).toContain('texra models list --quiet');
  });

  it('does not offer headless-only flags on interactive commands', async () => {
    const commands = await collectCommands(rootCommand);
    const flagsFor = (path: string) =>
      commands
        .find((command) => command.path.join(' ') === path)
        ?.flags.map((flag) => flag.name);

    expect(flagsFor('chat')).not.toContain('print');
    expect(flagsFor('chat')).not.toContain('output-format');
    expect(flagsFor('orchestrate')).not.toContain('print');
    expect(flagsFor('orchestrate')).not.toContain('output-format');
    expect(flagsFor('run')).toContain('print');
    expect(flagsFor('run')).toContain('output-format');
  });
});
