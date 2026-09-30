import { defineCommand } from 'citty';
import { Effect, FileSystem } from 'effect';

import {
  agentSourceDirectory,
  changedBuiltInOf,
  createWorkspaceAgentRosterController,
  customCopyPath,
  getAgent,
  getCustomAgentScanIssues,
  keepCustomAgent,
  writeStampedCopy,
} from '@agent/index';
import { AgentDirectories } from '@platform/interfaces';
import { agentKey, agentName } from '@shared/schemas';
import { isStrictlyWithin } from '@utils/core/pathCore';

import {
  AGENT_NAME_DESCRIPTION,
  CLI_AGENT_CATEGORY_FILTER_VALUES,
  formatCliAgentDetails,
  formatCliAgentList,
  formatCliHiddenAgentsNotice,
  formatCliNewerBuiltInNotice,
  loadCliAgentList,
  missingAgentMessage,
  parseCliAgentCategoryFilter,
  resolveCliAgent,
  type CliAgentListOptions,
} from '../runtime/agents';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult, emitPagedCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

export function listAgents(
  context: CliContext,
  options: CliAgentListOptions = {},
) {
  // The platform init and the list read below are one program, run on the
  // process runtime the command entry installs.
  return Effect.gen(function* () {
    const services = yield* initCliPlatform(context);
    const result = yield* loadCliAgentList(services, options);

    if (!context.quietLogs) {
      const hiddenNotice = formatCliHiddenAgentsNotice(
        result.hiddenCount,
        options.category,
      );
      if (hiddenNotice) writeTextStderr(hiddenNotice);
      for (const issue of getCustomAgentScanIssues()) {
        writeTextStderr(`Skipped custom agent ${issue.path}: ${issue.message}`);
      }
      for (const agent of result.agents) {
        if (changedBuiltInOf(agent)) {
          writeTextStderr(formatCliNewerBuiltInNotice(agent.name));
        }
      }
    }

    yield* emitPagedCliResult(context, {
      json: result.agents,
      ndjson: result.agents.map((agent) => ({ kind: 'agent', agent })),
      text: formatCliAgentList(result.agents, {
        category: options.category,
        showEmptyState:
          options.includeHidden !== true &&
          !context.quietLogs &&
          context.outputFormat === 'text',
      }),
    });
    return CliExitCode.Success;
  });
}

export function showAgent(context: CliContext, name: string) {
  return Effect.gen(function* () {
    const services = yield* initCliPlatform(context);
    const entry = yield* resolveCliAgent(services, name);
    if (!entry) {
      writeTextStderr(missingAgentMessage(name));
      return CliExitCode.Usage;
    }
    if (!context.quietLogs && changedBuiltInOf(entry)) {
      writeTextStderr(formatCliNewerBuiltInNotice(entry.name));
    }

    emitCliResult(context, {
      json: entry,
      ndjson: { kind: 'agent', agent: entry },
      text: formatCliAgentDetails(entry),
    });
    return CliExitCode.Success;
  });
}

/** The bundled agent a bare name or a bundled `source:name` key names. */
function bundledAgentNamed(name: string) {
  return (['builtInToolUse', 'builtInWorkflow'] as const)
    .map((source) => getAgent(agentKey(source, agentName(name))))
    .find((entry) => entry !== undefined);
}

/** One result shape for customize, reset and keep. */
function emitCopyResult(
  context: CliContext,
  result: {
    readonly action: 'customized' | 'reset' | 'kept';
    readonly name: string;
    readonly path: string;
    readonly text: string;
  },
) {
  const { text, ...copy } = result;
  emitCliResult(context, {
    json: copy,
    ndjson: { kind: 'agent-copy', copy },
    text,
  });
}

function refuse(message: string) {
  writeTextStderr(message);
  return CliExitCode.Usage;
}

/** Copy a bundled agent into the custom agents directory, stamped `basedOn`. */
function customizeAgent(context: CliContext, name: string) {
  return Effect.gen(function* () {
    yield* initCliPlatform(context);
    const builtIn = bundledAgentNamed(name);
    if (builtIn?.digest == null) {
      return refuse(`No built-in agent named ${name}.`);
    }
    const directories = yield* AgentDirectories;
    const target = customCopyPath({
      entryPath: builtIn.path,
      source: builtIn.source,
      sourceDir: yield* agentSourceDirectory(directories, builtIn.source),
      customDir: yield* directories.custom(),
    });
    if (!target) {
      return refuse(
        'Refusing to copy: target escapes the custom agents directory.',
      );
    }
    if (yield* FileSystem.FileSystem.use((fs) => fs.exists(target))) {
      return refuse(`A custom copy already exists: ${target}`);
    }
    yield* writeStampedCopy(builtIn.path, target, builtIn.digest);
    emitCopyResult(context, {
      action: 'customized',
      name: builtIn.name,
      path: target,
      text: `Created custom copy of ${builtIn.name}: ${target}`,
    });
    return CliExitCode.Success;
  });
}

/** Delete the custom copy that overrides a bundled agent. */
function resetAgent(context: CliContext, name: string) {
  return Effect.gen(function* () {
    const services = yield* initCliPlatform(context);
    const custom = getAgent(agentKey('custom', name));
    if (!custom || !bundledAgentNamed(name)) {
      return refuse(`${name} is not a custom copy of a built-in agent.`);
    }
    const customDir = yield* (yield* AgentDirectories).custom();
    if (!isStrictlyWithin(customDir, custom.path)) {
      return refuse(
        'Refusing to delete: file is not inside the custom agents directory.',
      );
    }
    yield* FileSystem.FileSystem.use((fs) =>
      fs.remove(custom.path, { force: true }),
    );
    yield* createWorkspaceAgentRosterController(services).forgetDeletedAgent(
      name,
    );
    emitCopyResult(context, {
      action: 'reset',
      name,
      path: custom.path,
      text: `Removed ${custom.path}; ${name} uses the built-in version again.`,
    });
    return CliExitCode.Success;
  });
}

/** Keep the custom copy and dismiss its newer-built-in notice. */
function keepAgent(context: CliContext, name: string) {
  return Effect.gen(function* () {
    yield* initCliPlatform(context);
    const custom = getAgent(agentKey('custom', name));
    if (!custom || !(yield* keepCustomAgent(name))) {
      return refuse(`${name} has no newer built-in version to dismiss.`);
    }
    emitCopyResult(context, {
      action: 'kept',
      name,
      path: custom.path,
      text: `Kept your ${name}; it is now based on the current built-in version.`,
    });
    return CliExitCode.Success;
  });
}

const NAME_ARG = {
  type: 'positional',
  required: true,
  description: AGENT_NAME_DESCRIPTION,
} as const;

const agentsCustomizeCommand = defineCliCommand({
  meta: {
    name: 'customize',
    description: 'Copy a built-in agent into your custom agents folder to edit',
  },
  args: { ...GLOBAL_ARGS, name: NAME_ARG },
  catchExitCode: CliExitCode.AgentError,
  run: (context, ctx) => customizeAgent(context, ctx.args.name),
});

const agentsResetCommand = defineCliCommand({
  meta: {
    name: 'reset',
    description: 'Delete your copy of a built-in agent so the built-in is used',
  },
  args: { ...GLOBAL_ARGS, name: NAME_ARG },
  catchExitCode: CliExitCode.AgentError,
  run: (context, ctx) => resetAgent(context, ctx.args.name),
});

const agentsKeepCommand = defineCliCommand({
  meta: {
    name: 'keep',
    description:
      'Keep your copy of a built-in agent and dismiss the newer-version notice',
  },
  args: { ...GLOBAL_ARGS, name: NAME_ARG },
  catchExitCode: CliExitCode.AgentError,
  run: (context, ctx) => keepAgent(context, ctx.args.name),
});

const agentsListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List available agents' },
  args: {
    ...GLOBAL_ARGS,
    all: {
      type: 'boolean',
      description:
        'Show every agent, including agents hidden by workspace visibility settings',
    },
    category: {
      type: 'enum',
      options: CLI_AGENT_CATEGORY_FILTER_VALUES,
      description:
        'Only list one category: workflow or toolUse (also accepts tool-use/tool_use)',
    },
  },
  run: (context, ctx) =>
    listAgents(context, {
      includeHidden: ctx.args.all === true,
      category: parseCliAgentCategoryFilter(optString(ctx.args.category)),
    }),
});

const agentsShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show one agent' },
  args: {
    ...GLOBAL_ARGS,
    name: {
      type: 'positional',
      required: true,
      description: `${AGENT_NAME_DESCRIPTION} (use \`source:name\` to disambiguate when the same name exists in multiple sources)`,
    },
  },
  // A catalog that fails to load is an error line and a non-zero exit, not a
  // CLI crash.
  catchExitCode: CliExitCode.AgentError,
  run: (context, ctx) => showAgent(context, ctx.args.name),
});

export const agentsCommand = defineCommand({
  meta: { name: 'agents', description: 'Inspect TeXRA agents' },
  // `show` already prints everything about an agent, so there is no separate
  // `inspect` verb here (unlike `team show`, which resolves a team run
  // plan).
  subCommands: {
    list: agentsListCommand,
    show: agentsShowCommand,
    customize: agentsCustomizeCommand,
    reset: agentsResetCommand,
    keep: agentsKeepCommand,
  },
});
