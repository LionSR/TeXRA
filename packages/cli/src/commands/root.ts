import { defineCommand } from 'citty';
import { Effect, Layer, Option, Ref } from 'effect';
import {
  Argument,
  CliConfig,
  CliError,
  Command,
  Completions,
  GlobalFlag,
} from 'effect/cli';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { TEXRA_SITE_URL } from '@ui/copy/guide';

import {
  isInteractiveCli,
  readCliAmbientState,
  readCliArgv,
  readCliVersion,
  CliUsageError,
} from '../runtime/platform/cliContext';
import { CliExitCode } from '../runtime/platform/exitCodes';
import {
  writeTextStderr,
  writeTextStdout,
} from '../runtime/platform/logSinks';

import {
  isCliError,
  resolveDeepestSubCommand,
  normalizeRootShortcuts,
  reorderGlobalFlags,
  reorderNestedGlobalFlags,
  showUsage,
  formatCliArgumentError,
  withUsageSections,
  detectUnknownCliCommand,
  firstPositionalIndex,
  formatUnknownCliCommand,
  detectUnknownCliFlag,
  formatUnknownCliFlag,
} from './_helpers/dispatch';
import { runCommandForExitCode } from './_helpers/exitCode';
import { AGENT_RUN_GLOBAL_ARGS } from './_helpers/globalArgs';
import {
  CLI_GLOBAL_FLAGS,
  CliSelection,
  readCliGlobalArgs,
  selectCliCommand,
  type CliLaunch,
} from './_helpers/cliCommand';
import { cliPresenterLayer, UsageSections } from './_helpers/cliHelp';

import { agentsCommand } from './agents';
import { authCommand } from './auth';
import { chatCommand, chatOptions } from './chat';
import { cloneCommand } from './clone';
import { configCommand } from './config';
import { doctorCommand } from './doctor';
import { historyCommand } from './history';
import { initCommand } from './init';
import { installGithubActionCommand } from './installGithubAction';
import { memoryCommand } from './memory';
import { modelsCommand } from './models';
import { pluginCommand } from './plugin';
import { resumeCommand } from './resume';
import { serveCommand, serviceCommand } from './service';
import { setupCommand } from './setup';
import { skillsCommand } from './skills';
import { tasksCommand } from './tasks';
import { versionCommand } from './version';
import { headlessRunCommand } from './run';

// TRIAL: the commands not yet converted keep their citty tree.
export const cittyRootCommand = withUsageSections(
  defineCommand({
    // Citty's `runMain` reads `meta.version` for `--version`/`-v`. We resolve
    // lazily so the bundled binary picks up the version emitted by the build
    // (see `readCliVersion` in cliContext.ts).
    meta: () => ({
      name: 'texra',
      description: 'TeXRA CLI — your AI theorist in the terminal',
      version: readCliVersion(),
    }),
    // Global flags are duplicated here so citty's `findSubCommandIndex` knows
    // which leading flags take values (otherwise `texra --output-format ndjson
    // agents list` mis-detects `ndjson` as the subcommand). The actual parsing
    // happens on each subcommand; root only acts as a routing layer.
    args: {
      ...AGENT_RUN_GLOBAL_ARGS,
    },
    subCommands: {
      clone: cloneCommand,
      setup: setupCommand,
      serve: serveCommand,
      service: serviceCommand,
      tasks: tasksCommand,
      init: initCommand,
      config: configCommand,
      'install-github-action': installGithubActionCommand,
      memory: memoryCommand,
      agents: agentsCommand,
      skills: skillsCommand,
      plugin: pluginCommand,
      models: modelsCommand,
      doctor: doctorCommand,
    },
    // `runCli` names `chat` or `help` for bare `texra` before dispatch.
    default: 'help',
  }),
  [],
);

/**
 * Re-implement the surface citty's `runMain` provides — explicit `--help`
 * detection plus error handling around `runCommand` — so usage errors (missing
 * required flag, unknown subcommand, invalid enum value) preserve our canonical
 * `CliExitCode.Usage` (2) instead of citty's hard-coded `exit(1)`. Root version
 * shortcuts normalize to the `version` subcommand before this point.
 */
export async function runCittyCli(
  argv?: readonly string[],
): Promise<{ exitCode: number }> {
  let rawArgs = reorderGlobalFlags(
    normalizeRootShortcuts(argv ? [...argv] : readCliArgv()),
  );
  rawArgs = await reorderNestedGlobalFlags(cittyRootCommand, rawArgs);

  const unknownCommand = await detectUnknownCliCommand(cittyRootCommand, rawArgs);
  if (unknownCommand) {
    writeTextStderr(formatUnknownCliCommand(unknownCommand));
    return { exitCode: CliExitCode.Usage };
  }

  // `--help` / `-h` anywhere prints usage for the deepest matched subcommand
  // (e.g. `texra agents list --help` → list-level usage), mirroring citty's
  // own `runMain` behavior without inheriting its `exit(1)` for usage errors.
  if (rawArgs.some((arg) => arg === '--help' || arg === '-h')) {
    await showUsage(
      await resolveDeepestSubCommand(cittyRootCommand, rawArgs),
      rawArgs,
    );
    return { exitCode: CliExitCode.Success };
  }

  const unknownFlag = await detectUnknownCliFlag(cittyRootCommand, rawArgs);
  if (unknownFlag) {
    writeTextStderr(formatUnknownCliFlag(unknownFlag));
    return { exitCode: CliExitCode.Usage };
  }

  try {
    return { exitCode: await runCommandForExitCode(cittyRootCommand, rawArgs) };
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeTextStderr(error.message);
      return { exitCode: CliExitCode.Usage };
    }
    if (isCliError(error)) {
      // The error and its usage pointer go to STDERR so STDOUT stays clean
      // and machine-parseable under `--output-format json|ndjson`. The
      // explicit `--help` path above keeps using STDOUT (`showUsage`) per
      // Unix convention.
      writeTextStderr(
        formatCliArgumentError(
          error.message,
          await resolveDeepestSubCommand(cittyRootCommand, rawArgs),
          rawArgs,
        ),
      );
      return { exitCode: CliExitCode.Usage };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The effect/cli command tree.
// ---------------------------------------------------------------------------

const EXAMPLES = [
        ['texra', 'start an interactive chat session'],
        ['texra setup', 'choose ChatGPT or add a key (guided)'],
        ['texra auth chatgpt login', 'sign in with a ChatGPT subscription'],
        ['texra auth grok login', 'sign in with a Grok (xAI) subscription'],
        ['texra chat', 'start an interactive tool-use session'],
        [
          'texra clone <project> ./project',
          'clone an Overleaf or ShareLaTeX project',
        ],
        [
          'texra run <program|agent> --input file.tex --instruction "<text>"',
          'run a program or an agent headless',
        ],
        ['texra tasks list', "list every project's tasks"],
        [
          'texra tasks attach <id>',
          'follow a task live, whichever window started it',
        ],
        ['texra agents list', 'list the available agents'],
        [
          'texra config agents --agents all',
          'make every agent visible in this workspace',
        ],
        [
          'texra plugin install github.com/<owner>/<repo>',
          'install a Claude Code or Codex plugin for its skills',
        ],
        ['texra init', 'save workspace defaults to .texra/config.json'],
        [
          'texra install-github-action',
          'add the TeXRA code-review workflow and open a PR',
        ],
        ['texra doctor', 'check your environment and configuration'],
      ] as const;

const UNCONVERTED = {
  clone: cloneCommand,
  setup: setupCommand,
  serve: serveCommand,
  service: serviceCommand,
  tasks: tasksCommand,
  init: initCommand,
  config: configCommand,
  'install-github-action': installGithubActionCommand,
  memory: memoryCommand,
  agents: agentsCommand,
  skills: skillsCommand,
  plugin: pluginCommand,
  models: modelsCommand,
  doctor: doctorCommand,
} as const;

// TRIAL: an unconverted command is listed in help and completions; argv
// naming it is routed to the citty tree before this one parses it.
const unconvertedStubs = Object.entries(UNCONVERTED).map(([name, command]) =>
  Command.make(name).pipe(
    Command.withDescription(
      command.meta !== undefined && 'description' in command.meta
        ? (command.meta.description ?? '')
        : '',
    ),
  ),
);

const completionCommand = Command.make(
  'completion',
  {
    shell: Argument.Literals('shell', [
      'bash',
      'zsh',
      'fish',
      'powershell',
    ]).pipe(
      Argument.withDescription('Shell name: bash, zsh, fish, or powershell'),
    ),
  },
  ({ shell }): Effect.Effect<void> =>
    Effect.sync(() =>
      writeTextStdout(
        Completions.generate(
          'texra',
          shell,
          Completions.fromCommand(cliRootCommand),
        ),
      ),
    ),
).pipe(Command.withDescription('Print shell completion script'));

// `texra help <path...>` is `texra <path...> --help`: `selectCli` rewrites
// it before the parse, so this command is here to be listed.
const helpCommand = Command.make('help', {
  command: Argument.String('command').pipe(
    Argument.withDescription('The command to show help for'),
    Argument.variadic(),
  ),
}).pipe(Command.withDescription('Show TeXRA CLI commands'));

/**
 * Bare `texra`: an interactive chat where `texra chat` would run, the root
 * help otherwise.
 */
const startChatOrHelp = Effect.gen(function* () {
  const globalArgs = yield* readCliGlobalArgs;
  if (!isInteractiveCli(globalArgs, readCliAmbientState())) {
    return yield* new CliError.ShowHelp({ commandPath: ['texra'], errors: [] });
  }
  return yield* selectCliCommand(
    'chat',
    chatOptions,
  )({ agent: Option.none(), model: Option.none() });
});

const cliRootCommand = Command.make('texra', {}, () => startChatOrHelp).pipe(
  Command.withDescription('TeXRA CLI — your AI theorist in the terminal'),
  Command.withSubcommands([
    chatCommand,
    headlessRunCommand,
    resumeCommand,
    historyCommand,
    authCommand,
    ...unconvertedStubs,
    completionCommand,
    versionCommand,
    helpCommand,
  ]),
  Command.withGlobalFlags(CLI_GLOBAL_FLAGS),
  Command.annotate(UsageSections, [
    { title: 'EXAMPLES', rows: EXAMPLES },
    { title: `Learn more: ${TEXRA_SITE_URL}`, rows: [] },
  ]),
);

/**
 * Parse `argv` and answer what it selected: the exit code of a command line
 * that ran nothing past the parse (help, a usage error, completions), or the
 * selected command's launch, which the process entry runs.
 */
const selectCli = Effect.fn('selectCli')(function* (
  argv: readonly string[] = readCliArgv(),
) {
  let rawArgs = normalizeRootShortcuts([...argv]);
  const routed = reorderGlobalFlags(rawArgs);
  const first = firstPositionalIndex(routed);
  const name = first === undefined ? undefined : routed[first];
  if (name === 'help' && first !== undefined) {
    rawArgs = [...routed.slice(0, first), ...routed.slice(first + 1), '--help'];
  }
  // TRIAL: route an unconverted command to the citty tree.
  if (name !== undefined && Object.hasOwn(UNCONVERTED, name)) {
    const launch: CliLaunch = async () => (await runCittyCli(rawArgs)).exitCode;
    return launch;
  }
  const selection = yield* Ref.make<CliLaunch | undefined>(undefined);
  const colors =
    readCliAmbientState().stdoutColorEnabled === true &&
    !rawArgs.includes('--no-color');
  return yield* Command.runWith(cliRootCommand, {
    version: readCliVersion(),
  })(rawArgs).pipe(
    Effect.andThen(Ref.get(selection)),
    Effect.map((launch): CliLaunch | number => launch ?? CliExitCode.Success),
    Effect.catch((error) => {
      // Help and the usage error are already printed. A group named with no
      // subcommand is a usage error; the bare root is not.
      if (CliError.isCliError(error) && error._tag === 'ShowHelp') {
        return Effect.succeed(
          error.errors.length === 0 && error.commandPath.length === 1
            ? CliExitCode.Success
            : CliExitCode.Usage,
        );
      }
      if (error instanceof CliUsageError) {
        return Effect.sync(() => {
          writeTextStderr(error.message);
          return CliExitCode.Usage;
        });
      }
      return Effect.fail(error);
    }),
    Effect.provideService(CliSelection, selection),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        cliPresenterLayer(colors),
        CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
      ),
    ),
  );
});

/**
 * The CLI's one invocation: parse `argv`, then run the command it selected
 * at this Promise edge, outside the parse's fiber, and answer the exit code.
 */
export async function runCli(
  argv?: readonly string[],
): Promise<{ exitCode: number }> {
  const selected = await Effect.runPromise(selectCli(argv));
  return {
    exitCode: typeof selected === 'number' ? selected : await selected(),
  };
}
