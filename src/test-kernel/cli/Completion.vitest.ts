import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { rootCommand } from '@cli/commands/root';
import { generateCompletionScript } from '@cli/runtime/completion';
import { bashCompletion } from '@cli/runtime/completionBash';
import {
  collectCommands,
  type CompletionCommand,
} from '@cli/runtime/completionCommandTree';

function bashQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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

/** Run a bash completion probe against the generated script: drop the
 *  self-registration `complete` line, append the probe body, execute it, and
 *  return the lines the probe printed. Any bash failure is a test failure. */
function probeBashCompletion(script: string, body: string): string[] {
  const result = spawnSync('bash', ['-s'], {
    input: `${script.replace(/\ncomplete .*_texra texra\n$/, '\n')}\n${body}`,
    encoding: 'utf8',
  });

  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout.trim().split('\n');
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

  it('uses the right bash agent listing at each launch boundary', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'texra-completion-bin-'));
    const bin = path.join(root, 'bin');

    try {
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, 'texra'),
        `#!/usr/bin/env bash
if [[ "$*" == "agents list --quiet --all" ]]; then
  printf 'workflow\\tpolish\\ntoolUse\\treview\\n'
elif [[ "$*" == "agents list --quiet --all --category toolUse" ]]; then
  printf 'toolUse\\treview\\ntoolUse\\tlean\\n'
elif [[ "$*" == "agents list --quiet" ]]; then
  printf 'workflow\\tpolish\\ntoolUse\\treview\\n'
elif [[ "$*" == "models list --quiet" ]]; then
  printf 'gpt54\\n'
fi
`,
        { mode: 0o755 },
      );
      const completions = probeBashCompletion(
        bash,
        `
if command -v cygpath >/dev/null; then
  export PATH="$(cygpath -u ${bashQuote(bin)}):$PATH"
else
  export PATH=${bashQuote(bin)}:$PATH
fi
COMP_WORDS=(texra run p)
COMP_CWORD=2
_texra
printf 'run:%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(texra run r)
COMP_CWORD=2
_texra
printf 'run-tool-use:%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(texra chat --agent l)
COMP_CWORD=3
_texra
printf 'agent-flag:%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(texra agents show p)
COMP_CWORD=3
_texra
printf 'agents-show:%s\\n' "\${COMPREPLY[@]}"
`,
      );

      expect(completions).toEqual([
        'run:polish',
        'run-tool-use:review',
        'agent-flag:lean',
        'agents-show:polish',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps spaced bash file completions as one candidate', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'texra-completion-'));

    try {
      writeFileSync(path.join(root, 'paper draft.tex'), '');
      writeFileSync(path.join(root, 'regular-file.tex'), '');
      const spacedDir = path.join(root, 'paper drafts');
      mkdirSync(spacedDir);
      writeFileSync(path.join(spacedDir, '.keep'), '', { flag: 'w' });
      const completions = probeBashCompletion(
        bash,
        `
TEXRA_COMPLETION_DYNAMIC=0
cd ${bashQuote(root)}
COMP_WORDS=(texra run polish --input "paper")
COMP_CWORD=4
_texra
printf '%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(texra --cwd "paper")
COMP_CWORD=2
_texra
printf '%s\\n' "\${COMPREPLY[@]}"
`,
      );

      expect(completions).toContain('paper draft.tex');
      expect(completions).toContain('paper drafts');
      expect(completions).not.toContain('regular-file.tex');
    } finally {
      rmSync(root, { recursive: true, force: true });
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
    expect(flagsFor('multi-agent run')).toContain('instruction-file');
  });
});
