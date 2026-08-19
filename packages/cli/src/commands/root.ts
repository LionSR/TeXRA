import { defineCommand, runCommand } from 'citty';

import {
  readCliAmbientState,
  readCliArgv,
  readCliVersion,
  CliUsageError,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStderr } from '../runtime/logSinks';

import {
  isCliError,
  resolveDeepestSubCommand,
  normalizeRootShortcuts,
  reorderGlobalFlags,
  reorderNestedGlobalFlags,
  setUsageColorOverrideFromRawArgs,
  showUsage,
  showUsageStderr,
  withUsageSections,
  detectUnknownCliCommand,
  formatUnknownCliCommand,
  detectUnknownCliFlag,
  formatUnknownCliFlag,
} from './_helpers/dispatch';
import { getExitCode, resetExitCode } from './_helpers/exitCode';
import { AGENT_RUN_GLOBAL_ARGS } from './_helpers/globalArgs';

import { agentsCommand } from './agents';
import {
  AUTH_SUBCOMMAND_NAMES,
  authCommand,
  loginCommand,
  logoutCommand,
} from './auth';
import { chatCommand } from './chat';
import { cloneCommand } from './clone';
import { completionCommand } from './completion';
import { configCommand } from './config';
import { doctorCommand } from './doctor';
import { helpCommand } from './help';
import { HISTORY_SUBCOMMAND_NAMES, historyCommand } from './history';
import { initCommand } from './init';
import { installGithubActionCommand } from './installGithubAction';
import { memoryCommand } from './memory';
import { modelsCommand } from './models';
import { multiAgentCommand } from './multiAgent';
import { orchestrationCommand } from './orchestrate';
import { resumeCommand } from './resume';
import { setupCommand } from './setup';
import { skillsCommand } from './skills';
import { toolsCommand } from './tools';
import { versionCommand } from './version';
import { runWorkflowCommand } from './workflow';

function defaultRootSubcommand(): 'orchestrate' | 'help' {
  const ambient = readCliAmbientState();
  return ambient.stdinIsTty && ambient.stdoutIsTty ? 'orchestrate' : 'help';
}

export const rootCommand = withUsageSections(
  defineCommand({
    // Citty's `runMain` reads `meta.version` for `--version`/`-v`. We resolve
    // lazily so the bundled binary picks up the version emitted by the build
    // (see `readCliVersion` in cliContext.ts).
    meta: async () => ({
      name: 'texra',
      description: 'TeXRA CLI — your AI theorist in the terminal',
      version: await readCliVersion(),
    }),
    // Global flags are duplicated here so citty's `findSubCommandIndex` knows
    // which leading flags take values (otherwise `texra --output-format ndjson
    // agents list` mis-detects `ndjson` as the subcommand). The actual parsing
    // happens on each subcommand; root only acts as a routing layer.
    args: {
      ...AGENT_RUN_GLOBAL_ARGS,
    },
    subCommands: {
      orchestrate: orchestrationCommand,
      chat: chatCommand,
      clone: cloneCommand,
      run: runWorkflowCommand,
      resume: resumeCommand,
      setup: setupCommand,
      init: initCommand,
      config: configCommand,
      'install-github-action': installGithubActionCommand,
      history: historyCommand,
      memory: memoryCommand,
      agents: agentsCommand,
      skills: skillsCommand,
      tools: toolsCommand,
      'multi-agent': multiAgentCommand,
      models: modelsCommand,
      // `login`/`logout` are convenience shortcuts; the full auth surface
      // (login, logout, status, usage, token) lives under `auth`.
      login: loginCommand,
      logout: logoutCommand,
      auth: authCommand,
      doctor: doctorCommand,
      completion: completionCommand,
      version: versionCommand,
      help: helpCommand,
    },
    // No subcommand on bare `texra`: dispatch to the orchestration view when
    // both TTYs are interactive; fall through to synthetic `help` otherwise.
    default: defaultRootSubcommand,
  }),
  [
    {
      title: 'EXAMPLES',
      rows: [
        ['texra', 'open the interactive launcher'],
        ['texra setup', 'choose ChatGPT, sign in, or add a key (guided)'],
        ['texra auth chatgpt login', 'sign in with a ChatGPT subscription'],
        ['texra auth grok login', 'sign in with a Grok (xAI) subscription'],
        ['texra login', 'sign in with Researcher Access'],
        ['texra chat', 'start an interactive tool-use session'],
        [
          'texra clone <project> --cwd ./paper',
          'clone an Overleaf or ShareLaTeX project',
        ],
        ['texra run <agent> --input file.tex', 'run a workflow agent headless'],
        ['texra agents list', 'list the available agents'],
        ['texra config agents --all', 'show all agents in this workspace'],
        ['texra init', 'save workspace defaults to .texra/config.json'],
        [
          'texra install-github-action',
          'add the TeXRA code-review workflow and open a PR',
        ],
        ['texra doctor', 'check your environment and configuration'],
      ],
    },
    // Footer rows are empty, so `formatUsageSection` renders just this title.
    { title: 'Learn more: https://texra.ai', rows: [] },
  ],
);

/**
 * Re-implement the surface citty's `runMain` provides — explicit `--help`
 * detection plus error handling around `runCommand` — so usage errors (missing
 * required flag, unknown subcommand, invalid enum value) preserve our canonical
 * `CliExitCode.Usage` (2) instead of citty's hard-coded `exit(1)`. Root version
 * shortcuts normalize to the `version` subcommand before this point.
 */
export async function runCli(
  argv?: readonly string[],
): Promise<{ exitCode: number }> {
  resetExitCode();
  let rawArgs = reorderGlobalFlags(
    normalizeRootShortcuts(argv ? [...argv] : readCliArgv()),
  );
  rawArgs = reorderNestedGlobalFlags(rawArgs, {
    command: 'auth',
    subCommands: AUTH_SUBCOMMAND_NAMES,
  });
  rawArgs = reorderNestedGlobalFlags(rawArgs, {
    command: 'history',
    subCommands: HISTORY_SUBCOMMAND_NAMES,
  });
  setUsageColorOverrideFromRawArgs(rawArgs);

  const unknownCommand = await detectUnknownCliCommand(rootCommand, rawArgs);
  if (unknownCommand) {
    writeTextStderr(formatUnknownCliCommand(unknownCommand));
    return { exitCode: CliExitCode.Usage };
  }

  // `--help` / `-h` anywhere prints usage for the deepest matched subcommand
  // (e.g. `texra agents list --help` → list-level usage), mirroring citty's
  // own `runMain` behavior without inheriting its `exit(1)` for usage errors.
  if (rawArgs.some((arg) => arg === '--help' || arg === '-h')) {
    const resolved = await resolveDeepestSubCommand(rootCommand, rawArgs);
    await showUsage(resolved.command, resolved.parent, resolved);
    return { exitCode: CliExitCode.Success };
  }

  const unknownFlag = await detectUnknownCliFlag(rootCommand, rawArgs);
  if (unknownFlag) {
    writeTextStderr(formatUnknownCliFlag(unknownFlag));
    return { exitCode: CliExitCode.Usage };
  }

  try {
    await runCommand(rootCommand, { rawArgs });
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeTextStderr(error.message);
      return { exitCode: CliExitCode.Usage };
    }
    if (isCliError(error)) {
      const resolved = await resolveDeepestSubCommand(rootCommand, rawArgs);
      // Usage shown on an ERROR goes to STDERR so STDOUT stays clean and
      // machine-parseable under `--output-format json|ndjson`. The explicit
      // `--help` path above keeps using STDOUT (`showUsage`) per Unix
      // convention.
      await showUsageStderr(resolved.command, resolved.parent, resolved);
      writeTextStderr(error.message);
      return { exitCode: CliExitCode.Usage };
    }
    throw error;
  }
  return { exitCode: getExitCode() };
}
