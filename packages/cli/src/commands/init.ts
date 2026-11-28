import { Effect, FileSystem, Option } from 'effect';
import { Flag } from 'effect/cli';

import { pathExists } from '@texra-ai/worldline/node';
import { workspaceTexraConfigPath } from '@texra/platform/defaults/nodeStorage';

import { failUsage, type CliContext } from '../runtime/platform/cliContext';
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
import { CLI_DEFAULT_MODEL_CANDIDATE } from '../runtime/models/launchDefaults';
import { CLI_SETUP_RECOVERY } from '../runtime/models/modelAccess';
import { isModelOptionAvailable } from '@texra-ai/worldline/schemas';
import { chooseLaunchModel } from '@texra/model/setupCredentialAccess';
import type { ModelOptionData } from '@texra/shared/pickerOptions';

import { boolFlag, cliCommand } from './_helpers/cliCommand';
import { cliResult, emitCliResult } from '../runtime/platform/output';

interface InitSummary {
  readonly path: string;
  readonly model: string;
  readonly outputFormat: InitConfigShape['texra.outputFormat'];
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
  model: string,
  models: readonly ModelOptionData[],
): InitSummary['warning'] {
  const chosen = models.find((option) => option.value === model);
  if (chosen !== undefined && isModelOptionAvailable(chosen)) return undefined;
  return {
    model,
    message: `"${model}" is not currently usable.`,
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
  config: InitConfigShape,
  models: readonly ModelOptionData[],
  gitignore: GitignoreOutcome | undefined,
) {
  const warning = initWarning(config['texra.model'], models);
  const summary: InitSummary = {
    path: filePath,
    model: config['texra.model'],
    outputFormat: config['texra.outputFormat'],
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
    return yield* failUsage(
      `Refusing to overwrite existing config at ${filePath}. Re-run with --force to replace it.`,
    );
  }

  // The default is the model a launch with nothing configured takes, so
  // accepting it changes no run.
  const { decision, rows: models } = yield* chooseLaunchModel(services, [
    CLI_DEFAULT_MODEL_CANDIDATE,
  ]);
  const defaultModel = decision?.model ?? CLI_DEFAULT_MODEL_CANDIDATE.model;

  const interactive =
    !opts.yes &&
    context.mode !== 'headless' &&
    context.stdoutIsTty &&
    !context.termIsDumb;

  let answers: InitAnswers;
  let gitignore: boolean;

  if (interactive) {
    const { runInitWizard } = yield* Effect.promise(
      () => import('../init/runInitWizard'),
    );
    const result = yield* runInitWizard({
      models,
      defaultModel,
      colorEnabled: context.stdoutColorEnabled,
    });
    if (!result) {
      writeTextStderr('Cancelled. No config written.');
      return;
    }
    answers = result.answers;
    gitignore = result.gitignore;
  } else {
    answers = { model: defaultModel, outputFormat: 'text' };
    gitignore = opts.gitignore ?? false;
  }

  const config = buildInitConfig(answers);
  yield* writeInitConfig(filePath, config);

  const gitignoreOutcome: GitignoreOutcome | undefined = gitignore
    ? yield* ensureTexraGitignored(context.cwd)
    : undefined;

  yield* emitInitSummary(filePath, config, models, gitignoreOutcome);
});

export const initCommand = cliCommand('init', {
  description: 'Bootstrap a .texra/config.json with sensible defaults',
  config: {
    yes: boolFlag('yes', 'Accept defaults non-interactively').pipe(
      Flag.withAlias('y'),
    ),
    force: boolFlag('force', 'Overwrite an existing config file'),
    // Absent leaves the choice to the wizard (or `false` without one);
    // `--no-gitignore` refuses it.
    gitignore: Flag.Boolean('gitignore').pipe(
      Flag.withDescription(
        'Add .texra/ to .gitignore (non-interactive default: false)',
      ),
      Flag.optional,
    ),
  },
  run: (context, input) =>
    runInit(context, {
      yes: input.yes,
      force: input.force,
      gitignore: Option.getOrUndefined(input.gitignore),
    }),
});
