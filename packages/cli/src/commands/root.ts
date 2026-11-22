// Third-party imports
import { Effect, Option } from 'effect';
import { Argument, CliError, Command } from 'effect/cli';

// Local imports - app
import { TEXRA_SITE_URL } from '@ui/copy/guide';

// Local imports - CLI
import {
  isInteractiveCli,
  readCliAmbientState,
  readCliArgv,
} from '../runtime/platform/cliContext';
import { writeTextStdout } from '../runtime/platform/logSinks';
import { bashCompletion } from '../runtime/completion/completionBash';
import {
  CLI_COMPLETION_SHELLS,
  collectCommands,
  type CliCompletionShell,
  type CompletionCommand,
} from '../runtime/completion/completionCommandTree';
import { fishCompletion } from '../runtime/completion/completionFish';
import { zshCompletion } from '../runtime/completion/completionZsh';

import {
  CLI_GLOBAL_FLAG_DESCRIPTORS,
  CLI_GLOBAL_FLAGS,
  readCliGlobalArgs,
  runCliCommandLine,
  selectCliCommand,
  SKILL_SOURCES_CONFIG,
} from './_helpers/cliCommand';

import { agentsCommand } from './agents';
import { authCommand } from './auth';
import { chatCommand, chatOptions } from './chat';
import { cloneCommand } from './clone';
import { configCommand } from './config';
import { doctorCommand } from './doctor';
import { historyCommand } from './history';
import { initCommand } from './init';
import { installGithubActionCommand } from './installGithubAction';
import { modelsCommand } from './models';
import { pluginCommand } from './plugin';
import { resumeCommand } from './resume';
import { serveCommand, serviceCommand } from './service';
import { setupCommand } from './setup';
import { skillsCommand } from './skills';
import { tasksCommand } from './tasks';
import { versionCommand } from './version';
import { headlessRunCommand } from './run';

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

const COMPLETION_SCRIPT: Record<
  CliCompletionShell,
  (commands: readonly CompletionCommand[]) => string
> = { bash: bashCompletion, zsh: zshCompletion, fish: fishCompletion };

const completionCommand = Command.make(
  'completion',
  {
    shell: Argument.Literals('shell', CLI_COMPLETION_SHELLS).pipe(
      Argument.withDescription('Shell name: bash, zsh, or fish'),
    ),
  },
  ({ shell }): Effect.Effect<void> =>
    Effect.sync(() =>
      writeTextStdout(COMPLETION_SCRIPT[shell](collectCommands(rootCommand))),
    ),
).pipe(Command.withDescription('Print shell completion script'));

/**
 * Bare `texra`: an interactive chat where `texra chat` would run, the root
 * help otherwise.
 */
const startChatOrHelp = Effect.fn('startChatOrHelp')(function* (input: {
  readonly skillSources: readonly string[];
}) {
  const globalArgs = yield* readCliGlobalArgs(input.skillSources);
  if (!isInteractiveCli(globalArgs, readCliAmbientState())) {
    return yield* new CliError.ShowHelp({ commandPath: ['texra'], errors: [] });
  }
  return yield* selectCliCommand(
    'chat',
    chatOptions,
  )({ ...input, agent: Option.none(), model: Option.none() });
});

const rootCommand = Command.make(
  'texra',
  SKILL_SOURCES_CONFIG,
  startChatOrHelp,
).pipe(
  Command.withDescription(
    `TeXRA CLI — your AI theorist in the terminal. Learn more: ${TEXRA_SITE_URL}`,
  ),
  Command.withSubcommands([
    chatCommand,
    cloneCommand,
    headlessRunCommand,
    resumeCommand,
    setupCommand,
    serveCommand,
    serviceCommand,
    tasksCommand,
    initCommand,
    configCommand,
    installGithubActionCommand,
    historyCommand,
    agentsCommand,
    skillsCommand,
    pluginCommand,
    modelsCommand,
    authCommand,
    doctorCommand,
    completionCommand,
    versionCommand,
  ]),
  Command.withGlobalFlags(CLI_GLOBAL_FLAGS),
  Command.withExamples(
    EXAMPLES.map(([command, description]) => ({ command, description })),
  ),
);

const GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(
  CLI_GLOBAL_FLAG_DESCRIPTORS.filter(
    (flag) => flag.type._tag !== 'Boolean',
  ).flatMap((flag) => [
    `--${flag.name}`,
    ...flag.aliases.map((alias) => `-${alias}`),
  ]),
);

/**
 * The root's shortcuts, ahead of any command name: `-v` and `--version` are
 * `texra version`, `--resume <id>` is `texra resume <id>`.
 */
function expandRootShortcuts(argv: readonly string[]): readonly string[] {
  // An index loop: a global flag's value is skipped with its flag.
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // A command name or the end of options: no shortcut after it.
    if (arg === undefined || arg === '--' || !arg.startsWith('-')) return argv;
    const before = argv.slice(0, index);
    const after = argv.slice(index + 1);
    if (arg === '-v' || arg === '--version')
      return [...before, 'version', ...after];
    if (arg === '--resume') return [...before, 'resume', ...after];
    if (arg.startsWith('--resume=')) {
      return [...before, 'resume', arg.slice('--resume='.length), ...after];
    }
    if (GLOBAL_VALUE_FLAGS.has(arg)) index += 1;
  }
  return argv;
}

/** The `texra` binary's one invocation; the exit code is its answer. */
export function runCli(
  argv: readonly string[] = readCliArgv(),
): Promise<{ exitCode: number }> {
  return runCliCommandLine(rootCommand, expandRootShortcuts(argv));
}
