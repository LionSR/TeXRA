import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { rootCommand } from '@cli/commands/root';
import {
  CLI_COMPLETION_SHELLS,
  generateCompletionScript,
} from '@cli/runtime/completion';
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

  for (const shell of CLI_COMPLETION_SHELLS) {
    it(`generates ${shell} completion`, async () => {
      const script = await generateCompletionScript(rootCommand, shell);

      expect(script).toMatchSnapshot();
    });
  }

  it('keeps dynamic completion gated by TEXRA_COMPLETION_DYNAMIC', () => {
    expect(bash).toContain('TEXRA_COMPLETION_DYNAMIC');
    expect(bash).toContain('texra agents list --quiet');
    expect(bash).toContain(
      'texra agents list --quiet --all --category workflow',
    );
    expect(bash).toContain(
      'texra agents list --quiet --all --category toolUse',
    );
    expect(bash).toContain('texra models list --quiet');
  });

  it('advertises the negated no-color flag in every shell', async () => {
    const [bash, zsh, fish] = await Promise.all(
      CLI_COMPLETION_SHELLS.map((shell) =>
        generateCompletionScript(rootCommand, shell),
      ),
    );

    expect(bash).toContain('--no-color');
    expect(zsh).toContain('--no-color[Disable ANSI color on every stream]');
    expect(fish).toContain("-l 'no-color'");
  });

  it('uses dynamic zsh completions for agent and model flag values', async () => {
    const zsh = await generateCompletionScript(rootCommand, 'zsh');

    expect(zsh).toContain(
      "'--agent[Tool-use agent for the session]:agent:($(_texra_tool_use_agents))'",
    );
    expect(zsh).toContain(
      "'--model[Model for the session]:model:($(_texra_models))'",
    );
    expect(zsh).toContain(
      "'-m[Model for the session]:model:($(_texra_models))'",
    );
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

  it('does not offer bash positionals while completing flag values', () => {
    const lines = bash.split('\n');
    // Each lookup must land on a real line: the toContain assertions below
    // fail loudly on `undefined`, which is exactly the missing-line case.
    const fileValueLine = lines.find((line) =>
      line.includes('_texra_compgen_files "$cur"'),
    );
    const directoryValueLine = lines.find((line) =>
      line.includes('_texra_compgen_dirs "$cur"'),
    );
    const genericValueLine = lines.find((line) =>
      line.includes('COMPREPLY=(); return'),
    );

    expect(bash).toContain('compgen -f -- "$1"');
    expect(bash).toContain('compgen -d -- "$1"');
    expect(fileValueLine).toContain('--input');
    expect(fileValueLine).toContain('-i');
    expect(fileValueLine).toContain('--context');
    expect(fileValueLine).toContain('-c');
    expect(fileValueLine).toContain('--output');
    expect(fileValueLine).toContain('--instruction-file');
    expect(directoryValueLine).toContain('--cwd');
    expect(directoryValueLine).toContain('--output-dir');
    expect(directoryValueLine).toContain('--source');
    expect(directoryValueLine).toContain('-s');
    expect(genericValueLine).toContain('--instruction');
    expect(genericValueLine).toContain('--api-mode');
    expect(bash).toContain(
      '--model|-m) COMPREPLY=( $(compgen -W "$(_texra_models)" -- "$cur") ); return ;;',
    );
    expect(bash).toContain(
      '--agent) COMPREPLY=( $(compgen -W "$(_texra_tool_use_agents)" -- "$cur") ); return ;;',
    );
  });

  it('uses category-specific bash agent completions at launch boundaries', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'texra-completion-bin-'));
    const bin = path.join(root, 'bin');

    try {
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, 'texra'),
        `#!/usr/bin/env bash
if [[ "$*" == "agents list --quiet --all --category workflow" ]]; then
  printf 'workflow\\tpolish\\nworkflow\\tcorrect\\n'
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
COMP_WORDS=(texra agents run r)
COMP_CWORD=3
_texra
printf 'agents-run:%s\\n' "\${COMPREPLY[@]}"
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
        'agents-run:review',
        'agent-flag:lean',
        'agents-show:polish',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps fish workflow agent completion scoped to top-level run', async () => {
    const fish = await generateCompletionScript(rootCommand, 'fish');

    expect(fish).toContain(
      "complete -c texra -n '__fish_seen_subcommand_from run; and not __fish_seen_subcommand_from agents; and not __fish_seen_subcommand_from multi-agent' -a '(test \"$TEXRA_COMPLETION_DYNAMIC\" != 0; and texra agents list --quiet --all --category workflow",
    );
    expect(fish).toContain(
      "complete -c texra -n '__fish_seen_subcommand_from agents; and __fish_seen_subcommand_from run' -a '(test \"$TEXRA_COMPLETION_DYNAMIC\" != 0; and texra agents list --quiet --all --category toolUse",
    );
  });

  it('does not emit fish completions for the removed agents inspect command', async () => {
    const fish = await generateCompletionScript(rootCommand, 'fish');

    expect(fish).not.toContain('__fish_seen_subcommand_from inspect');
    expect(fish).not.toContain('agents inspect');
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
        positionals: [],
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
    expect(flagsFor('orchestrate')).not.toContain('print');
    expect(flagsFor('orchestrate')).not.toContain('output-format');
    expect(flagsFor('run')).toContain('print');
    expect(flagsFor('run')).toContain('output-format');
    expect(flagsFor('multi-agent run')).toContain('instruction-file');
  });

  it('describes multi-agent root options without calling orchestrators tool-use agents', async () => {
    const commands = await collectCommands(rootCommand);
    const runFlags = commandAt(commands, 'multi-agent run').flags;

    expect(runFlags.find((flag) => flag.name === 'agent')?.description).toBe(
      'Root agent for the team run (defaults to the preset orchestrator)',
    );
    expect(runFlags.find((flag) => flag.name === 'model')?.description).toBe(
      'Model for the team root agent',
    );
  });
});
