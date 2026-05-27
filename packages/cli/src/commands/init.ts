import { defineCommand } from 'citty';

import { getVisibleAgents, loadAgents } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';

import { CLI_BUILTIN_DEFAULT_MODEL } from '../runtime/cliConfig';
import { BUILTIN_DEFAULT_CHAT_AGENT } from '../runtime/chatDefaults';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr, writeTextStdout } from '../runtime/logSinks';
import { getCliModelAccessList } from '../runtime/modelAccess';
import {
  buildInitConfig,
  configFileExists,
  ensureTexraGitignored,
  initConfigPath,
  writeInitConfig,
  type InitAnswers,
} from '../runtime/initConfig';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import type { CliContext } from '../runtime/cliContext';

async function gatherOptions(): Promise<{
  agents: { name: string; description?: string }[];
  models: {
    value: string;
    label: string;
    available: boolean;
    status: string;
  }[];
}> {
  await loadAgents({ includeRemote: false });
  const agents = getVisibleAgents(AgentCategory.ToolUse).map((agent) => ({
    name: agent.name,
    description: agent.description,
  }));
  const models = (await getCliModelAccessList()).map((entry) => ({
    value: entry.model.value,
    label: entry.model.label ?? entry.model.value,
    available: entry.available,
    status: entry.status,
  }));
  return { agents, models };
}

function defaultAnswers(
  models: { value: string; available: boolean }[],
): InitAnswers {
  const firstAvailable = models.find((model) => model.available);
  return {
    agent: BUILTIN_DEFAULT_CHAT_AGENT,
    model: firstAvailable?.value ?? CLI_BUILTIN_DEFAULT_MODEL,
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
  models: { value: string; available: boolean }[],
): void {
  const lines = [
    `Wrote ${filePath}`,
    `  agent: ${answers.agent}`,
    `  model: ${answers.model}`,
    `  approval: ${answers.approvalPolicy}`,
    `  output: ${answers.outputFormat}`,
  ];
  const chosen = models.find((model) => model.value === answers.model);
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

  const filePath = initConfigPath(context.cwd);
  if (!opts.force && (await configFileExists(filePath))) {
    writeTextStderr(
      `Refusing to overwrite existing config at ${filePath}. Re-run with --force to replace it.`,
    );
    return CliExitCode.Usage;
  }

  const { agents, models } = await gatherOptions();

  const interactive =
    !opts.yes &&
    context.mode !== 'headless' &&
    context.stdoutIsTty === true &&
    context.termIsDumb !== true;

  let answers: InitAnswers;
  let gitignore: boolean;

  if (interactive) {
    const { runInitWizard } = await import('../init/runInitWizard');
    const result = await runInitWizard({ agents, models });
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

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Bootstrap a .texra/config.json with sensible defaults',
  },
  args: {
    cwd: {
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
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(
      await runInit(context, {
        yes: ctx.args.yes === true,
        force: ctx.args.force === true,
        gitignore:
          typeof ctx.args.gitignore === 'boolean'
            ? ctx.args.gitignore
            : undefined,
      }),
    );
  },
});
