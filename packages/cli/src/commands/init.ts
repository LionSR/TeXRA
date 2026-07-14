import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import { getVisibleAgents, loadAgents } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { CLI_BUILTIN_DEFAULT_MODEL } from '../runtime/cliConfig';
import {
  implicitDefaultToolUseAgents,
  pickDefaultToolUseAgent,
} from '../runtime/defaultAgents';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import { effectiveCliApiMode, type CliApiMode } from '../runtime/apiAccessMode';
import {
  formatCliNoAvailableModelsRecovery,
  getCliModelAccessList,
  type CliModelAccess,
} from '../runtime/modelAccess';
import {
  buildInitConfig,
  configFileExists,
  ensureTexraGitignored,
  writeInitConfig,
  type GitignoreOutcome,
  type InitAnswers,
  type InitConfigShape,
} from '../runtime/initConfig';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { emitCliResult } from './_helpers/output';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import {
  resolveCliStdoutColorEnabled,
  type CliContext,
} from '../runtime/cliContext';

interface InitAgentOption {
  readonly name: string;
}

export function defaultInitAgentOptions(
  agents: readonly InitAgentOption[],
): InitAgentOption[] {
  return implicitDefaultToolUseAgents(agents).map((agent) => ({
    name: agent.name,
  }));
}

async function gatherOptions(apiMode: CliApiMode): Promise<{
  agents: InitAgentOption[];
  models: CliModelAccess[];
}> {
  await loadAgents({ includeRemote: false });
  const agents = defaultInitAgentOptions(
    getVisibleAgents(AgentCategory.ToolUse),
  );
  const models = await getCliModelAccessList({
    apiMode,
    agentCategory: AgentCategory.ToolUse,
  });
  return { agents, models };
}

export function defaultInitAnswers(
  agents: readonly InitAgentOption[],
  models: readonly CliModelAccess[],
): InitAnswers {
  const firstAvailable = models.find((model) => model.available);
  return {
    agent: pickDefaultToolUseAgent(agents),
    model: firstAvailable?.model.value ?? CLI_BUILTIN_DEFAULT_MODEL,
    // Match the runtime default (see buildCliContext). `ask` prompts in
    // interactive runs and safely denies in headless ones — unlike `never`,
    // which silently denies every privileged action.
    approvalPolicy: 'ask',
    outputFormat: 'text',
  };
}

interface InitSummary {
  readonly path: string;
  readonly agent: string;
  readonly model: string;
  readonly approvalPolicy: InitAnswers['approvalPolicy'];
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
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
): InitSummary['warning'] {
  const chosen = models.find((model) => model.model.value === answers.model);
  if (chosen?.available === true) return undefined;
  return {
    model: answers.model,
    message: `"${answers.model}" is not usable in the current access mode.`,
    recovery: `${formatCliNoAvailableModelsRecovery(apiMode)} Run \`texra models list --all\` to inspect access.`,
  };
}

function initNextSteps(warning: InitSummary['warning']): readonly string[] {
  if (!warning) {
    return ['Next: run `texra` for the launcher, or `texra chat` to start.'];
  }
  return [
    `Next: ${warning.recovery}`,
    'After a model is available, run `texra` for the launcher or `texra chat` to start.',
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
    `  approval: ${summary.approvalPolicy}`,
    `  output: ${summary.outputFormat}`,
  ];
  if (summary.warning) {
    lines.push('', `Note: ${summary.warning.message}`);
  }
  lines.push('', ...summary.next);
  return lines.join('\n');
}

function emitInitSummary(
  context: CliContext,
  filePath: string,
  answers: InitAnswers,
  config: InitConfigShape,
  models: readonly CliModelAccess[],
  gitignore: GitignoreOutcome | undefined,
  apiMode: CliApiMode,
): void {
  const warning = initWarning(answers, models, apiMode);
  const summary: InitSummary = {
    path: filePath,
    agent: answers.agent,
    model: answers.model,
    approvalPolicy: answers.approvalPolicy,
    outputFormat: answers.outputFormat,
    config,
    gitignore,
    warning,
    next: initNextSteps(warning),
  };
  emitCliResult(context, {
    json: summary,
    ndjson: { kind: 'init-config', init: summary },
    text: initTextSummary(summary),
  });
}

async function runInit(
  context: CliContext,
  opts: {
    yes: boolean;
    force: boolean;
    gitignore: boolean | undefined;
  },
): Promise<number> {
  // Don't skip included access: model availability must reflect the user's
  // real access mode (a signed-in relay user has no personal keys but can use
  // included models), so the picker annotates and defaults correctly.
  await initCliPlatform({ ...context, quietLogs: true });

  const filePath = workspaceTexraConfigPath(context.cwd);
  if (!opts.force && (await configFileExists(filePath))) {
    writeTextStderr(
      `Refusing to overwrite existing config at ${filePath}. Re-run with --force to replace it.`,
    );
    return CliExitCode.Usage;
  }

  const apiMode = effectiveCliApiMode(context);
  const { agents, models } = await gatherOptions(apiMode);

  const interactive =
    !opts.yes &&
    context.mode !== 'headless' &&
    context.stdoutIsTty === true &&
    context.termIsDumb !== true;

  let answers: InitAnswers;
  let gitignore: boolean;

  if (interactive) {
    const { runInitWizard } = await import('../init/runInitWizard');
    const result = await runInitWizard({
      agents,
      models,
      colorEnabled: resolveCliStdoutColorEnabled(context),
    });
    if (!result) {
      writeTextStderr('Cancelled. No config written.');
      return CliExitCode.Success;
    }
    answers = result.answers;
    gitignore = result.gitignore;
  } else {
    answers = defaultInitAnswers(agents, models);
    gitignore = opts.gitignore ?? false;
  }

  const config = buildInitConfig(answers);
  try {
    await writeInitConfig(filePath, config);
  } catch (error: unknown) {
    throw error;
  }

  let gitignoreOutcome: GitignoreOutcome | undefined;
  if (gitignore) {
    gitignoreOutcome = await ensureTexraGitignored(context.cwd);
  }

  emitInitSummary(
    context,
    filePath,
    answers,
    config,
    models,
    gitignoreOutcome,
    apiMode,
  );
  return CliExitCode.Success;
}

export const initCommand = defineCliCommand({
  meta: {
    name: 'init',
    description: 'Bootstrap a .texra/config.json with sensible defaults',
  },
  args: {
    ...GLOBAL_ARGS,
    cwd: {
      ...GLOBAL_ARGS.cwd,
      type: 'string',
      description: 'Working directory to initialize (defaults to $PWD)',
    },
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
