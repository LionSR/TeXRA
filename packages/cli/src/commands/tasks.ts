/**
 * `texra tasks`: the TeXRA service's tasks, from any terminal. Every
 * subcommand is a client of the one service (started on demand): it lists
 * the tasks of every project, starts one in the service, attaches to one
 * live, sends it a follow-up, or stops it. The service owns every task it
 * runs, so a task outlives the terminal that started it.
 */
import { defineCommand } from 'citty';
import { Effect, Schema } from 'effect';

import {
  type RunId,
  AgentConfigSchema,
  type AgentConfigPayload,
  type RequestError,
  ensureError,
} from '@texra-ai/harness/schemas';
import type { TaskSummary } from '@texra/controllers/server/protocol';
import {
  requestOnService,
  type ServiceClient,
} from '@texra/controllers/server/client';
import { requestErrorText } from '@ui/copy/requestErrors';
import { runStatusLabel } from '@ui/copy/runStatus';

import { resolveCliRunAgent } from '../runtime/agents';
import {
  CliUsageError,
  launchApproval,
  launchApprovalNotice,
  projectApprovalPolicy,
  CliInvocation,
} from '../runtime/cliContext';
import {
  isLinked,
  linkClient,
  type CliServiceLink,
} from '../runtime/cliService';
import { environmentApiKeys } from '@texra/controllers/server/serviceSession';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { getStdoutColumns, writeTextStderr } from '../runtime/logSinks';
import { selectCliRunModel } from '../runtime/runModel';
import { attachTask } from '../runtime/taskAttach';
import { runOutcomeExitCode } from '../runtime/terminalStatus';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import { formatToolUseAgentRunInstruction } from './_helpers/runInstructions';
import type { RuntimeRequest } from '@texra-ai/harness/schemas';

/** The text width an attach lays rows out at when stdout is not a terminal,
 *  so a saved transcript does not depend on who saved it. */
const PIPED_COLUMNS = 100;

const TASK_ID_ARG = {
  type: 'positional',
  required: true,
  description: 'Task id (or a unique prefix) from `texra tasks list`',
} as const;

/** The task `id` names: its full id, or a prefix only one task has. */
function findTask(client: ServiceClient, id: string) {
  return client['tasks.list']({ all: true }).pipe(
    Effect.flatMap((tasks) => {
      const exact = tasks.find((task) => task.runId === id);
      const matches = exact
        ? [exact]
        : tasks.filter((task) => task.runId.startsWith(id));
      if (matches.length === 1) return Effect.succeed(matches[0]);
      return Effect.fail(
        new CliUsageError({
          message:
            matches.length === 0
              ? `No task ${id}. \`texra tasks list\` shows the tasks.`
              : `${matches.length} tasks start with ${id}; give more of the id.`,
        }),
      );
    }),
  );
}

/** The service's client, through the platform's link; a command that
 *  holds none fails with why. */
const serviceClient = CliInvocation.use(({ context }) =>
  Effect.flatMap(
    initCliPlatform({ ...context, startsService: true }),
    ({ service }: { readonly service: CliServiceLink }) =>
      isLinked(service)
        ? linkClient(service)
        : Effect.fail(new Error(service.none)),
  ),
);

/** One request to the task `id` names, refused as a usage error. */
function requestTask<R extends RuntimeRequest>(
  id: string,
  request: (runId: RunId) => R,
) {
  return Effect.gen(function* () {
    const { client } = yield* serviceClient;
    const task = yield* findTask(client, id);
    const outcome = yield* requestOnService(
      client,
      task.workspace,
      request(task.runId),
    ).pipe(
      Effect.catchIf(
        (error): error is RequestError => error._tag !== 'RpcClientError',
        (error) =>
          Effect.fail(new CliUsageError({ message: requestErrorText(error) })),
      ),
    );
    return { task, outcome };
  }).pipe(Effect.scoped);
}

function taskLine(task: TaskSummary): string {
  const live = task.live ? '*' : ' ';
  return `${live} ${task.runId}  ${runStatusLabel(task.statusKey).padEnd(12)} ${task.label}  (${task.workspace})`;
}

const listCommand = defineCliCommand({
  meta: {
    name: 'list',
    description:
      'List the tasks of every project, newest first (* = running in the service)',
  },
  args: { ...GLOBAL_ARGS },
  catchExitCode: CliExitCode.AgentError,
  run: Effect.fn('run')(function* () {
    const { client } = yield* serviceClient;
    const tasks = yield* client['tasks.list']({ all: false });
    yield* emitCliResult({
      json: tasks,
      ndjson: tasks.map((task) => ({ kind: 'task' as const, task })),
      text: tasks.length
        ? tasks.map(taskLine).join('\n')
        : 'No tasks yet. `texra tasks start <agent> --instruction …` starts one.',
    });
    return CliExitCode.Success;
  }, Effect.scoped),
});

const attachCommand = defineCliCommand({
  meta: {
    name: 'attach',
    description:
      'Follow a task live until it ends; Ctrl-C detaches and leaves it running',
  },
  args: { ...GLOBAL_ARGS, id: TASK_ID_ARG },
  catchExitCode: CliExitCode.AgentError,
  run: (context, ctx) => {
    // A live transcript has no single JSON document to print.
    if (context.outputFormat === 'json')
      throw new CliUsageError({
        message:
          '`texra tasks attach` prints text or NDJSON (`--output-format ndjson`), not JSON.',
      });
    return Effect.gen(function* () {
      const { client } = yield* serviceClient;
      const task = yield* findTask(client, ctx.args.id);
      const outcome = yield* attachTask(client, task, {
        format: context.outputFormat === 'ndjson' ? 'ndjson' : 'text',
        columns: context.stdoutIsTty
          ? (getStdoutColumns() ?? PIPED_COLUMNS)
          : PIPED_COLUMNS,
        color: context.stdoutColorEnabled,
      });
      return outcome === null
        ? CliExitCode.Success
        : runOutcomeExitCode(outcome);
    }).pipe(Effect.scoped);
  },
});

const startCommand = defineCliCommand({
  meta: {
    name: 'start',
    description:
      'Start an agent as a task in the TeXRA service and print its id',
  },
  args: {
    ...GLOBAL_ARGS,
    agent: {
      type: 'positional',
      required: true,
      description: 'Agent name from `texra agents list`',
    },
    instruction: {
      type: 'string',
      required: true,
      description: 'What the agent should do',
    },
    model: { type: 'string', alias: 'm', description: 'Model for the agent' },
  },
  catchExitCode: CliExitCode.AgentError,
  run: Effect.fn('tasks.run')(function* (context, ctx) {
    const instruction = ctx.args.instruction.trim();
    if (!instruction)
      return yield* new CliUsageError({
        message: '--instruction must not be empty.',
      });
    const services = yield* initCliPlatform({
      ...context,
      startsService: true,
    });
    if (!isLinked(services.service))
      return yield* Effect.fail(new Error(services.service.none));
    const link = services.service;
    // The task runs in the service under the project's persisted policy,
    // with what this command asked for riding the launch
    // (`launchApproval`).
    const requested = context.requestedApprovalPolicy;
    const refused = launchApprovalNotice(
      requested,
      projectApprovalPolicy(services.config),
    );
    if (refused !== undefined) writeTextStderr(refused);
    const agent = yield* resolveCliRunAgent(services, ctx.args.agent);
    const model = yield* selectCliRunModel(
      context,
      optString(ctx.args.model),
      'chat',
      services,
    );
    const payload: AgentConfigPayload = {
      agent: ctx.args.agent,
      agentSource: agent.source,
      model,
      inputFiles: [],
      contextFiles: [],
      instruction: formatToolUseAgentRunInstruction({
        inputFiles: [],
        contextFiles: [],
        instruction,
      }),
      displayInstruction: instruction,
      workingDirectory: context.cwd,
    };
    const config =
      yield* Schema.decodeUnknownEffect(AgentConfigSchema)(payload);
    const { runId } = yield* Effect.flatMap(linkClient(link), ({ client }) =>
      client['task.start']({
        workspace: context.cwd,
        start: {
          config,
          approval: launchApproval(requested),
          apiKeys: environmentApiKeys(),
        },
      }),
    ).pipe(Effect.mapError(ensureError));
    yield* emitCliResult({
      json: { runId, workspace: context.cwd },
      ndjson: { kind: 'task', task: { runId, workspace: context.cwd } },
      text: runId,
    });
    return CliExitCode.Success;
  }),
});

const sendCommand = defineCliCommand({
  meta: { name: 'send', description: 'Send a running task a follow-up' },
  args: {
    ...GLOBAL_ARGS,
    id: TASK_ID_ARG,
    text: {
      type: 'positional',
      required: true,
      description: 'The follow-up message',
    },
  },
  catchExitCode: CliExitCode.AgentError,
  run: (_, ctx) =>
    requestTask(ctx.args.id, (runId) => ({
      kind: 'followUp.send',
      runId,
      text: ctx.args.text,
    })).pipe(
      Effect.flatMap(({ task, outcome }) => {
        const { status } = outcome;
        return emitCliResult({
          json: { runId: task.runId, status },
          ndjson: { kind: 'task', task: { runId: task.runId, status } },
          text: `Follow-up ${status} to ${task.runId}.`,
        }).pipe(Effect.as(CliExitCode.Success));
      }),
    ),
});

const stopCommand = defineCliCommand({
  meta: {
    name: 'stop',
    description: 'Stop a running task; it can be resumed later',
  },
  args: { ...GLOBAL_ARGS, id: TASK_ID_ARG },
  catchExitCode: CliExitCode.AgentError,
  run: (_, ctx) =>
    requestTask(ctx.args.id, (runId) => ({
      kind: 'run.stop',
      runId,
      reason: 'user',
    })).pipe(
      Effect.flatMap(({ task }) =>
        emitCliResult({
          json: { runId: task.runId, stopped: true },
          ndjson: { kind: 'task', task: { runId: task.runId, stopped: true } },
          text: `Stopped ${task.runId}.`,
        }).pipe(Effect.as(CliExitCode.Success)),
      ),
    ),
});

export const tasksCommand = defineCommand({
  meta: {
    name: 'tasks',
    description:
      'List, start, follow and steer the tasks the TeXRA service runs for every window',
  },
  subCommands: {
    list: listCommand,
    start: startCommand,
    attach: attachCommand,
    send: sendCommand,
    stop: stopCommand,
  },
});
