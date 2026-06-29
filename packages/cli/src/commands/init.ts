import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import { getVisibleAgents, loadAgents } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { CLI_BUILTIN_DEFAULT_MODEL } from '../runtime/cliConfig';
import {
  BUILTIN_DEFAULT_CHAT_AGENT,
  implicitDefaultToolUseAgents,
} from '../runtime/defaultAgents';
import { CliExitCode } from '../runtime/exitCodes';
import { seedCliRosterFromDefaultTeam } from '../runtime/defaultTeamRoster';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr, writeTextStdout } from '../runtime/logSinks';
import { effectiveCliApiMode, type CliApiMode } from '../runtime/apiAccessMode';
import {
  getCliModelAccessList,
  type CliModelAccess,
} from '../runtime/modelAccess';
import {
  buildInitConfig,
  configFileExists,
  ensureTexraGitignored,
  writeInitConfig,
  type InitAnswers,
} from '../runtime/initConfig';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

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

function defaultAnswers(models: readonly CliModelAccess[]): InitAnswers {
  const firstAvailable = models.find((model) => model.available);
  return {
    agent: BUILTIN_DEFAULT_CHAT_AGENT,
    model: firstAvailable?.model.value ?? CLI_BUILTIN_DEFAULT_MODEL,
    // Match the runtime default (see buildCliContext). `ask` prompts in
    // interactive runs and safely denies in headless ones — unlike `never`,
    // which silently denies every privileged action.
    approvalPolicy: 'ask',
    outputFormat: 'text',
  };
}

function printSummary(
  filePath: string,
  answers: InitAnswers,
  models: readonly CliModelAccess[],
): void {
  const lines = [
    `Wrote ${filePath}`,
    `  agent: ${answers.agent}`,
    `  model: ${answers.model}`,
    `  approval: ${answers.approvalPolicy}`,
    `  output: ${answers.outputFormat}`,
  ];
  const chosen = models.find((model) => model.model.value === answers.model);
  if (chosen && !chosen.available) {
    lines.push(
      '',
      `Note: "${answers.model}" is not usable in the current access mode.`,
      'Run `texra login` for included relay access, set the provider API key, or run `texra models list` to pick another.',
    );
  }
  lines.push(
    '',
    'Next: run `texra` for the launcher, or `texra chat` to start.',
  );
  writeTextStdout(lines.join('\n'));
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

  const { agents, models } = await gatherOptions(effectiveCliApiMode(context));

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
      colorEnabled: context.stdoutColorEnabled ?? context.colorEnabled,
    });
    if (!result) {
      writeTextStderr('Cancelled. No config written.');
      return CliExitCode.Success;
    }
    answers = result.answers;
    gitignore = result.gitignore;
  } else {
    answers = defaultAnswers(models);
    gitignore = opts.gitignore ?? false;
  }

  await writeInitConfig(filePath, buildInitConfig(answers));

  // Seed a never-configured workspace's agent roster from the user-level
  // default team (the setup agent's apply_team) — the CLI counterpart of the
  // extension's activation-time seeding. Runs only after the config is written,
  // i.e. past the interactive cancel guard, so a cancelled `texra init` never
  // mutates the roster. Best-effort: a seeding failure must not fail init.
  await seedCliRosterFromDefaultTeam();

  if (gitignore) {
    const outcome = await ensureTexraGitignored(context.cwd);
    if (outcome !== 'present') {
      writeTextStdout(
        `${outcome === 'created' ? 'Created' : 'Updated'} .gitignore (.texra/ ignored).`,
      );
    }
  }

  printSummary(filePath, answers, models);
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
