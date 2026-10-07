/**
 * `texra tasks`: the TeXRA service's tasks, from any terminal. Every
 * subcommand is a client of the one service (started on demand): it lists
 * the tasks of every project, starts one in the service, attaches to one
 * live, sends it a follow-up, or stops it. The service owns every task it
 * runs, so a task outlives the terminal that started it.
 */
import { defineCommand } from 'citty';
import { Effect } from 'effect';

import { AgentConfigSchema, type AgentConfigPayload } from '@agent/runtime';
import { stricterPolicy } from '@shared/approvalBypassKind';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  texraApprovalPolicyLabel,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type { RequestErrorWire } from '@shared/session/sessionFrames';
import type { TaskSummary } from '@texra/controllers/server/protocol';
import type { ServiceClient } from '@texra/controllers/server/client';
import { readConfigSettingFrom } from '@utils/config/platformSettings';
import { generateRunId } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

import { resolveCliRunAgent } from '../runtime/agents';
import { CliUsageError, type CliContext } from '../runtime/cliContext';
import { connectCliService } from '../runtime/cliService';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { getStdoutColumns, writeTextStderr } from '../runtime/logSinks';
import { selectCliRunModel } from '../runtime/runModel';
import { attachTask, describeWireRefusal } from '../runtime/taskAttach';
import { runOutcomeExitCode } from '../runtime/terminalStatus';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import { formatToolUseAgentRunInstruction } from './_helpers/runInstructions';
import type { Outcome, RuntimeRequest } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

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
        new CliUsageError(
          matches.length === 0
            ? `No task ${id}. \`texra tasks list\` shows the tasks.`
            : `${matches.length} tasks start with ${id}; give more of the id.`,
        ),
      );
    }),
  );
}

/** One request to the task `id` names, refused as a usage error. */
function requestTask(
  context: CliContext,
  id: string,
  request: (runId: RunId) => RuntimeRequest,
) {
  return Effect.gen(function* () {
    const { client } = yield* connectCliService(context.storageRoot);
    const task = yield* findTask(client, id);
    const outcome: Outcome = yield* client['task.request']({
      workspace: task.workspace,
      request: request(task.runId),
    }).pipe(
      Effect.catchIf(
        (error): error is RequestErrorWire => error._tag !== 'RpcClientError',
        (error) => Effect.fail(new CliUsageError(describeWireRefusal(error))),
      ),
    );
    return { task, outcome };
  }).pipe(Effect.scoped);
}

function taskLine(task: TaskSummary): string {
  const live = task.live ? '*' : ' ';
  return `${live} ${task.runId}  ${task.statusLabel.padEnd(12)} ${task.label}  (${task.workspace})`;
}

const listCommand = defineCliCommand({
  meta: {
    name: 'list',
    description:
      'List the tasks of every project, newest first (* = running in the service)',
  },
  args: { ...GLOBAL_ARGS },
  catchExitCode: CliExitCode.AgentError,
  run: (context) =>
    Effect.gen(function* () {
      const { client } = yield* connectCliService(context.storageRoot);
      const tasks = yield* client['tasks.list']({ all: false });
      emitCliResult(context, {
        json: tasks,
        ndjson: tasks.map((task) => ({ kind: 'task' as const, task })),
        text: tasks.length
          ? tasks.map(taskLine).join('\n')
          : 'No tasks yet. `texra tasks start <agent> --instruction …` starts one.',
      });
      return CliExitCode.Success;
    }).pipe(Effect.scoped),
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
      throw new CliUsageError(
        '`texra tasks attach` prints text or NDJSON (`--output-format ndjson`), not JSON.',
      );
    return Effect.gen(function* () {
      const { client } = yield* connectCliService(context.storageRoot);
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
  run: (context, ctx) =>
    Effect.gen(function* () {
      const instruction = ctx.args.instruction.trim();
      if (!instruction)
        return yield* Effect.fail(
          new CliUsageError('--instruction must not be empty.'),
        );
      const services = yield* initCliPlatform(context);
      // The task runs in the service under the project's persisted policy.
      // This command's policy (its flag, `--no-input`, or the config) rides
      // the launch: stricter, it narrows this task only; more permissive,
      // it is said and ignored, since no client widens the project's.
      const configured = readConfigSettingFrom<TexraApprovalPolicy>(
        services.config,
        TEXRA_APPROVAL_POLICY_CONFIG_KEY,
      );
      if (
        stricterPolicy(context.approvalPolicy, configured) !==
        context.approvalPolicy
      )
        writeTextStderr(
          `The task runs in the TeXRA service under the project's approval policy, ${texraApprovalPolicyLabel(configured)}, not ${texraApprovalPolicyLabel(context.approvalPolicy)}: a launch can only narrow it. Change the project's policy with /approval in \`texra chat\` or in the settings view.`,
        );
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
      const config = yield* Effect.try({
        try: () => AgentConfigSchema.parse(payload),
        catch: ensureError,
      });
      const runId = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* connectCliService(context.storageRoot);
          return yield* client['task.start']({
            workspace: context.cwd,
            runId: generateRunId(),
            config,
            continues: null,
            preferHelperModel: false,
            ownApiKeyFallback: false,
            approvalPolicy: context.approvalPolicy,
            approveDelegatedWork: false,
          });
        }),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof Error ? error : new Error(error.message),
        ),
      );
      emitCliResult(context, {
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
  run: (context, ctx) =>
    requestTask(context, ctx.args.id, (runId) => ({
      kind: 'followUp.send',
      runId,
      text: ctx.args.text,
    })).pipe(
      Effect.map(({ task, outcome }) => {
        const status = outcome.kind === 'followUp' ? outcome.status : 'sent';
        emitCliResult(context, {
          json: { runId: task.runId, status },
          ndjson: { kind: 'task', task: { runId: task.runId, status } },
          text: `Follow-up ${status} to ${task.runId}.`,
        });
        return CliExitCode.Success;
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
  run: (context, ctx) =>
    requestTask(context, ctx.args.id, (runId) => ({
      kind: 'run.stop',
      runId,
      reason: 'user',
    })).pipe(
      Effect.map(({ task }) => {
        emitCliResult(context, {
          json: { runId: task.runId, stopped: true },
          ndjson: { kind: 'task', task: { runId: task.runId, stopped: true } },
          text: `Stopped ${task.runId}.`,
        });
        return CliExitCode.Success;
      }),
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
