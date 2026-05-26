import { defineCommand, runCommand } from 'citty';

import {
  readCliAmbientState,
  readCliArgv,
  readCliVersion,
  CliUsageError,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStderr, writeTextStdout } from '../runtime/logSinks';

import {
  detectUnknownCliCommand as detectUnknownCliCommandImpl,
  formatUnknownCliCommand,
  isCliError,
  normalizeRootShortcuts,
  reorderGlobalFlags,
  resolveDeepestSubCommand,
  showUsage,
  type UnknownCliCommand,
} from './_helpers/dispatch';
import { getExitCode, resetExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';

import { agentsCommand } from './agents';
import { authCommand, loginCommand, logoutCommand } from './auth';
import { chatCommand } from './chat';
import { completionCommand } from './completion';
import { doctorCommand } from './doctor';
import { helpCommand } from './help';
import { historyCommand } from './history';
import { initCommand } from './init';
import { memoryCommand } from './memory';
import { modelsCommand } from './models';
import { multiAgentCommand } from './multiAgent';
import { orchestrationCommand } from './orchestrate';
import { resumeCommand } from './resume';
import { skillsCommand } from './skills';
import { toolsCommand } from './tools';
import { versionCommand } from './version';
import { runWorkflowCommand } from './workflow';

export function defaultRootSubcommand(): 'orchestrate' | 'help' {
  const ambient = readCliAmbientState();
  return ambient.stdinIsTty && ambient.stdoutIsTty ? 'orchestrate' : 'help';
}

export const rootCommand = defineCommand({
  // Citty's `runMain` reads `meta.version` for `--version`/`-v`. We resolve
  // lazily so the bundled binary picks up the version emitted by the build
  // (see `readCliVersion` in cliContext.ts).
  meta: async () => ({
    name: 'texra',
    description: 'TeXRA CLI — AI LaTeX research assistant',
    version: await readCliVersion(),
  }),
  // Global flags are duplicated here so citty's `findSubCommandIndex` knows
  // which leading flags take values (otherwise `texra --output-format ndjson
  // agents list` mis-detects `ndjson` as the subcommand). The actual parsing
  // happens on each subcommand; root only acts as a routing layer.
  args: {
    ...GLOBAL_ARGS,
  },
  subCommands: {
    orchestrate: orchestrationCommand,
    chat: chatCommand,
    run: runWorkflowCommand,
    resume: resumeCommand,
    init: initCommand,
    history: historyCommand,
    memory: memoryCommand,
    agents: agentsCommand,
    skills: skillsCommand,
    tools: toolsCommand,
    'multi-agent': multiAgentCommand,
    models: modelsCommand,
    // `login`/`logout` are convenience shortcuts; the full auth surface
    // (login, logout, status, usage) lives under `auth`.
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
});

export async function detectUnknownCliCommand(
  rawArgs: readonly string[],
): Promise<UnknownCliCommand | undefined> {
  return detectUnknownCliCommandImpl(rootCommand, rawArgs);
}

/**
 * Re-implement the surface citty's `runMain` provides — `--help` / `--version`
 * detection plus error handling around `runCommand` — so usage errors (missing
 * required flag, unknown subcommand, invalid enum value) preserve our
 * canonical `CliExitCode.Usage` (2) instead of citty's hard-coded `exit(1)`.
 */
export async function runCli(
  argv?: readonly string[],
): Promise<{ exitCode: number }> {
  resetExitCode();
  const rawArgs = reorderGlobalFlags(
    normalizeRootShortcuts(argv ? [...argv] : readCliArgv()),
  );

  // `--help` / `-h` anywhere prints usage for the deepest matched subcommand
  // (e.g. `texra agents list --help` → list-level usage), mirroring citty's
  // own `runMain` behavior without inheriting its `exit(1)` for usage errors.
  if (rawArgs.some((arg) => arg === '--help' || arg === '-h')) {
    const [target, parent] = await resolveDeepestSubCommand(
      rootCommand,
      rawArgs,
    );
    await showUsage(target, parent);
    return { exitCode: CliExitCode.Success };
  }
  if (
    rawArgs.length === 1 &&
    (rawArgs[0] === '--version' || rawArgs[0] === '-v' || rawArgs[0] === '-V')
  ) {
    writeTextStdout(await readCliVersion());
    return { exitCode: CliExitCode.Success };
  }

  const unknownCommand = await detectUnknownCliCommand(rawArgs);
  if (unknownCommand) {
    writeTextStderr(formatUnknownCliCommand(unknownCommand));
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
      const [target, parent] = await resolveDeepestSubCommand(
        rootCommand,
        rawArgs,
      );
      await showUsage(target, parent);
      writeTextStderr(error.message);
      return { exitCode: CliExitCode.Usage };
    }
    throw error;
  }
  return { exitCode: getExitCode() };
}

// Re-exports retained for the existing test surface
// (`src/test-kernel/cli/*`). Keep this list narrow — new tests should import
// from the helper modules directly.
export { collectStringFlagValues } from './_helpers/globalArgs';
export {
  formatUnknownCliCommand,
  normalizeRootShortcuts,
  reorderGlobalFlags,
  type UnknownCliCommand,
} from './_helpers/dispatch';
export {
  isCliFetchStackLog,
  formatCliModelListError,
} from './_helpers/fetchSilencer';
export { cliTerminalStatus } from './_helpers/terminalStatus';
export { expandWorkflowInputSpecs } from './_helpers/workflowInputs';
export {
  resolveWorkflowOutput,
  resumeWorkflowOutputFile,
} from './_helpers/workflowOutput';
export { resolveLoginProvider } from './auth';
export { doctorPlatformInitContext } from './doctor';
