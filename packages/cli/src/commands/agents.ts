import { Effect } from 'effect';
import { Argument, Command } from 'effect/cli';

import { AgentCatalog } from '@texra-ai/harness/host';
import { AGENT_SOURCE, agentKey, agentName } from '@texra-ai/harness/schemas';

import {
  AGENT_NAME_DESCRIPTION,
  formatCliAgentDetails,
  formatCliAgentList,
  formatCliNewerBuiltInNotice,
  missingAgentMessage,
} from '../runtime/agents';
import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import { writeTextStderr } from '../runtime/platform/logSinks';

import { cliCommand } from './_helpers/cliCommand';
import {
  cliResult,
  emitCliResult,
  emitPagedCliResult,
} from './_helpers/output';
import {
  failUsage,
  isQuiet,
  type CliContext,
} from '../runtime/platform/cliContext';

const listAgents = Effect.fn('listAgents')(function* (context: CliContext) {
  yield* cliPlatform;
  const catalog = yield* AgentCatalog;
  const agents = catalog.list();

  if (!isQuiet(context)) {
    for (const issue of catalog.scanIssues()) {
      writeTextStderr(`Skipped custom agent ${issue.path}: ${issue.message}`);
    }
    for (const agent of agents) {
      if (catalog.newerBuiltIn(agent)) {
        writeTextStderr(formatCliNewerBuiltInNotice(agent.name));
      }
    }
  }

  yield* emitPagedCliResult(
    cliResult(
      'agent',
      agents,
      formatCliAgentList(agents, {
        showEmptyState: !isQuiet(context) && context.outputFormat === 'text',
      }),
    ),
  );
});

const showAgent = Effect.fn('showAgent')(function* (
  context: CliContext,
  name: string,
) {
  yield* cliPlatform;
  const catalog = yield* AgentCatalog;
  const entry = catalog.get(name);
  if (!entry) {
    return yield* failUsage(missingAgentMessage(name));
  }
  if (!isQuiet(context) && catalog.newerBuiltIn(entry)) {
    writeTextStderr(formatCliNewerBuiltInNotice(entry.name));
  }

  yield* emitCliResult(cliResult('agent', entry, formatCliAgentDetails(entry)));
});

/** The bundled agent a bare name or a bundled `source:name` key names. */
const bundledAgentNamed = (name: string) =>
  Effect.map(AgentCatalog, (catalog) =>
    catalog.get(agentKey(AGENT_SOURCE.BUILT_IN, agentName(name))),
  );

/** One result shape for customize, reset and keep. */
function emitCopyResult(result: {
  readonly action: 'customized' | 'reset' | 'kept';
  readonly name: string;
  readonly path: string;
  readonly text: string;
}) {
  const { text, ...copy } = result;
  return emitCliResult(cliResult('agent-copy', copy, text));
}

/** Copy a bundled agent into the custom agents directory, stamped `basedOn`. */
const customizeAgent = Effect.fn('customizeAgent')(function* (name: string) {
  yield* cliPlatform;
  const builtIn = yield* bundledAgentNamed(name);
  if (!builtIn) return yield* failUsage(`No built-in agent named ${name}.`);
  return yield* (yield* AgentCatalog).customize(builtIn, 'copy').pipe(
    Effect.flatMap(({ path }) =>
      emitCopyResult({
        action: 'customized',
        name: builtIn.name,
        path,
        text: `Created custom copy of ${builtIn.name}: ${path}`,
      }),
    ),
    Effect.catchTag('AgentCustomizeRefused', (refused) =>
      failUsage(refused.message),
    ),
  );
});

/** Delete the custom copy that overrides a bundled agent. */
const resetAgent = Effect.fn('resetAgent')(function* (name: string) {
  yield* cliPlatform;
  const catalog = yield* AgentCatalog;
  const custom = catalog.get(agentKey('custom', name));
  if (!custom || !(yield* bundledAgentNamed(name))) {
    return yield* failUsage(
      `${name} is not a custom copy of a built-in agent.`,
    );
  }
  return yield* catalog.removeCustom(name).pipe(
    Effect.flatMap((path) =>
      emitCopyResult({
        action: 'reset',
        name,
        path,
        text: `Removed ${path}; ${name} uses the built-in version again.`,
      }),
    ),
    Effect.catchTag('AgentCustomizeRefused', (refused) =>
      failUsage(refused.message),
    ),
  );
});

/** Keep the custom copy and dismiss its newer-built-in notice. */
const keepAgent = Effect.fn('keepAgent')(function* (name: string) {
  yield* cliPlatform;
  return yield* (yield* AgentCatalog).keepCustom(name).pipe(
    Effect.flatMap(({ path }) =>
      emitCopyResult({
        action: 'kept',
        name,
        path,
        text: `Kept your ${name}; it is now based on the current built-in version.`,
      }),
    ),
    Effect.catchTag('AgentCustomizeRefused', (refused) =>
      failUsage(refused.message),
    ),
  );
});

const NAME_CONFIG = {
  name: Argument.String('name').pipe(
    Argument.withDescription(AGENT_NAME_DESCRIPTION),
  ),
};

const agentsCustomizeCommand = cliCommand('customize', {
  description: 'Copy a built-in agent into your custom agents folder to edit',
  config: NAME_CONFIG,
  catchExitCode: CliExitCode.AgentError,
  run: (_, input) => customizeAgent(input.name),
});

const agentsResetCommand = cliCommand('reset', {
  description: 'Delete your copy of a built-in agent so the built-in is used',
  config: NAME_CONFIG,
  catchExitCode: CliExitCode.AgentError,
  run: (_, input) => resetAgent(input.name),
});

const agentsKeepCommand = cliCommand('keep', {
  description:
    'Keep your copy of a built-in agent and dismiss the newer-version notice',
  config: NAME_CONFIG,
  catchExitCode: CliExitCode.AgentError,
  run: (_, input) => keepAgent(input.name),
});

const agentsListCommand = cliCommand('list', {
  description: 'List the agents',
  config: {},
  run: (context) => listAgents(context),
});

const agentsShowCommand = cliCommand('show', {
  description: 'Show one agent',
  config: {
    name: Argument.String('name').pipe(
      Argument.withDescription(
        `${AGENT_NAME_DESCRIPTION} (use \`source:name\` to disambiguate when the same name exists in multiple sources)`,
      ),
    ),
  },
  // A catalog that fails to load is an error line and a non-zero exit, not a
  // CLI crash.
  catchExitCode: CliExitCode.AgentError,
  run: (context, input) => showAgent(context, input.name),
});

// `show` already prints everything about an agent, so there is no separate
// `inspect` verb here.
export const agentsCommand = Command.make('agents').pipe(
  Command.withDescription('Inspect TeXRA agents'),
  Command.withSubcommands([
    agentsListCommand,
    agentsShowCommand,
    agentsCustomizeCommand,
    agentsResetCommand,
    agentsKeepCommand,
  ]),
);
