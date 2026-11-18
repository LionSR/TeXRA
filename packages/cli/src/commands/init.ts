import { Effect, FileSystem } from 'effect';

import { AgentCatalog } from '@texra-ai/harness/host';
import { pathExists } from '@texra-ai/harness/node';
import { workspaceTexraConfigPath } from '@texra/platform/defaults/nodeStorage';

import { implicitDefaultToolUseAgents } from '@texra/shared/constants/agents';
import { CLI_CHEAP_START_MODEL } from '../runtime/platform/cliConfig';
import { type CliContext } from '../runtime/platform/cliContext';
import { pickDefaultToolUseAgent } from '../runtime/defaultAgents';
import { CliExitCode } from '../runtime/platform/exitCodes';
import {
  buildInitConfig,
  ensureTexraGitignored,
  writeInitConfig,
  type GitignoreOutcome,
  type InitAnswers,
  type InitConfigShape,
} from '../runtime/platform/initConfig';
import { cliPlatform } from '../runtime/platform/initPlatform';
import { writeTextStderr } from '../runtime/platform/logSinks';
import { CLI_SETUP_RECOVERY } from '../runtime/models/modelAccess';
import { isModelOptionAvailable } from '@texra-ai/harness/schemas';
import { loadModelOptions } from '@texra/model/setupCredentialAccess';
import type { ModelOptionData } from '@texra/shared/pickerOptions';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { cliResult, emitCliResult } from './_helpers/output';

interface InitAgentOption {
  readonly name: string;
}

function defaultInitAnswers(
  agents: readonly InitAgentOption[],
  models: readonly ModelOptionData[],
): InitAnswers {
  return {
    agent: pickDefaultToolUseAgent(agents),
    model: models.find(isModelOptionAvailable)?.value ?? CLI_CHEAP_START_MODEL,
    outputFormat: 'text',
  };
}

interface InitSummary {
  readonly path: string;
  readonly agent: string;
  readonly model: string;
  readonly outputFormat: InitAnswers['outputFormat'];
  readonly config: InitConfigShape;
  readonly gitignore?: GitignoreOutcome;
  readonly warning?: {
    readonly model: string;
    readonly message: string;
    readonly recovery: string;
  };
  readonly next: readonly string[];
}

function initWarning(
  answers: InitAnswers,
  models: readonly ModelOptionData[],
): InitSummary['warning'] {
  const chosen = models.find((model) => model.value === answers.model);
  if (chosen !== undefined && isModelOptionAvailable(chosen)) return undefined;
  return {
    model: answers.model,
    message: `"${answers.model}" is not currently usable.`,
    recovery: `${CLI_SETUP_RECOVERY} Run \`texra models list --all\` to inspect access.`,
  };
}

function initNextSteps(warning: InitSummary['warning']): readonly string[] {
  if (!warning) {
    return ['Next: run `texra` to start a chat.'];
  }
  return [
    `Next: ${warning.recovery}`,
    'After a model is available, run `texra` to start a chat.',
  ];
}

function initGitignoreText(outcome: GitignoreOutcome | undefined): string[] {
  if (outcome == null || outcome === 'present') return [];
  return [
    `${outcome === 'created' ? 'Created' : 'Updated'} .gitignore (.texra/ ignored).`,
  ];
}

function initTextSummary(summary: InitSummary): string {
  const lines = [
    ...initGitignoreText(summary.gitignore),
    `Wrote ${summary.path}`,
    `  agent: ${summary.agent}`,
    `  model: ${summary.model}`,
    `  output: ${summary.outputFormat}`,
  ];
  if (summary.warning) {
    lines.push('', `Note: ${summary.warning.message}`);
  }
  lines.push('', ...summary.next);
  return lines.join('\n');
}

function emitInitSummary(
  filePath: string,
  answers: InitAnswers,
  config: InitConfigShape,
  models: readonly ModelOptionData[],
  gitignore: GitignoreOutcome | undefined,
) {
  const warning = initWarning(answers, models);
  const summary: InitSummary = {
    path: filePath,
    agent: answers.agent,
    model: answers.model,
    outputFormat: answers.outputFormat,
    config,
    gitignore,
    warning,
    next: initNextSteps(warning),
  };
  return emitCliResult(
    cliResult('init-config', summary, initTextSummary(summary)),
  );
}

const runInit = Effect.fn('runInit')(function* (
  context: CliContext,
  opts: {
    yes: boolean;
    force: boolean;
    gitignore: boolean | undefined;
  },
) {
  // The init call hands back the stores it just wired, so the model list is
  // computed from the same pair the rest of this command writes through.
  const services = yield* cliPlatform;

  const filePath = workspaceTexraConfigPath(context.cwd);
  if (
    !opts.force &&
    (yield* FileSystem.FileSystem.use((fs) => pathExists(fs, filePath)))
  ) {
    writeTextStderr(
      `Refusing to overwrite existing config at ${filePath}. Re-run with --force to replace it.`,
    );
    return CliExitCode.Usage;
  }

  const agents = implicitDefaultToolUseAgents(
    yield* (yield* AgentCatalog).workspaceAgents(services).visible(),
  );
  const models = yield* loadModelOptions(services);

  const interactive =
    !opts.yes &&
    context.mode !== 'headless' &&
    context.stdoutIsTty === true &&
    context.termIsDumb !== true;

  let answers: InitAnswers;
  let gitignore: boolean;

  if (interactive) {
    const { runInitWizard } = yield* Effect.promise(
      () => import('../init/runInitWizard'),
    );
    const result = yield* runInitWizard({
      agents,
      models,
      colorEnabled: context.stdoutColorEnabled,
    });
    if (!result) {
      writeTextStderr('Cancelled. No config written.');
      return;
    }
    answers = result.answers;
    gitignore = result.gitignore;
  } else {
    answers = defaultInitAnswers(agents, models);
    gitignore = opts.gitignore ?? false;
  }

  const config = buildInitConfig(answers);
  yield* writeInitConfig(filePath, config);

  const gitignoreOutcome: GitignoreOutcome | undefined = gitignore
    ? yield* ensureTexraGitignored(context.cwd)
    : undefined;

  yield* emitInitSummary(filePath, answers, config, models, gitignoreOutcome);
});

export const initCommand = defineCliCommand({
  meta: {
    name: 'init',
    description: 'Bootstrap a .texra/config.json with sensible defaults',
  },
  args: {
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Accept defaults non-interactively',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite an existing config file',
    },
    gitignore: {
      type: 'boolean',
      description: 'Add .texra/ to .gitignore (non-interactive default: false)',
    },
  },
  run: (context, ctx) =>
    runInit(context, {
      yes: ctx.args.yes === true,
      force: ctx.args.force === true,
      gitignore:
        typeof ctx.args.gitignore === 'boolean'
          ? ctx.args.gitignore
          : undefined,
    }),
});
