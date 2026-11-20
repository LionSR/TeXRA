/**
 * `texra tasks`: the TeXRA service's tasks, from any terminal. Every
 * subcommand is a client of the one service (started on demand): it lists
 * the tasks of every project, starts one in the service, attaches to one
 * live, sends it a follow-up, or stops it. The service owns every task it
 * runs, so a task outlives the terminal that started it.
 */
import { Effect, Option, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';

import {
  type RunId,
  AgentConfigSchema,
  type AgentConfigPayload,
  type RequestError,
} from '@texra-ai/harness/schemas';
import type { TaskSummary } from '@texra/controllers/server/protocol';
import {
  findTask,
  linkedClient,
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
} from '../runtime/platform/cliContext';
import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import {
  getStdoutColumns,
  writeTextStderr,
} from '../runtime/platform/logSinks';
import { selectCliRunModel } from '../runtime/models/runModel';
import { attachTask } from '../runtime/headless/taskAttach';
import { runOutcomeExitCode } from '../runtime/headless/terminalStatus';

import { cliCommand } from './_helpers/cliCommand';
import { modelFlag } from './_helpers/flags';
import { cliResult, emitCliResult } from './_helpers/output';
import { formatToolUseAgentRunInstruction } from './_helpers/runInstructions';
import type { RuntimeCommand } from '@texra-ai/harness/schemas';

/** The text width an attach lays rows out at when stdout is not a terminal,
 *  so a saved transcript does not depend on who saved it. */
const PIPED_COLUMNS = 100;

const TASK_ID_ARG = Argument.String('id').pipe(
  Argument.withDescription(
    'Task id (or a unique prefix) from `texra tasks list`',
  ),
);

/** The task `id` names (`findTask`); naming none or several is a usage
 *  error. */
const taskNamed = (client: ServiceClient, id: string) =>
  Effect.flatMap(findTask(client, id), (found) =>
    'task' in found
      ? Effect.succeed(found.task)
      : Effect.fail(
          new CliUsageError({
            message:
              found.matches.length === 0
                ? `No task ${id}. \`texra tasks list\` shows the tasks.`
                : `${found.matches.length} tasks start with ${id}; give more of the id.`,
          }),
        ),
  );

/** The service's client, through the platform's link; a command that
 *  holds none fails with why. */
const serviceClient = cliPlatform.pipe(
  Effect.flatMap(({ service }) => Effect.fromResult(service)),
  Effect.flatMap(linkedClient),
);

/** One request to the task `id` names, refused as a usage error. */
function requestTask<R extends RuntimeCommand>(
  id: string,
  request: (runId: RunId) => R,
) {
  return Effect.gen(function* () {
    const client = yield* serviceClient;
    const task = yield* taskNamed(client, id);
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

const listCommand = cliCommand('list', {
  description:
    'List the tasks of every project, newest first (* = running in the service)',
  config: {},
  platform: { startsService: true },
  catchExitCode: CliExitCode.AgentError,
  run: Effect.fn('run')(function* () {
    const client = yield* serviceClient;
    const tasks = yield* client['tasks.list']({ all: false });
    yield* emitCliResult(
      cliResult(
        'task',
        tasks,
        tasks.length
          ? tasks.map(taskLine).join('\n')
          : 'No tasks yet. `texra tasks start <agent> --instruction …` starts one.',
      ),
    );
  }, Effect.scoped),
});

const attachCommand = cliCommand('attach', {
  description:
    'Follow a task live until it ends; Ctrl-C detaches and leaves it running',
  config: { id: TASK_ID_ARG },
  platform: { startsService: true },
  catchExitCode: CliExitCode.AgentError,
  run: (context, input) => {
    // A live transcript has no single JSON document to print.
    if (context.outputFormat === 'json')
      throw new CliUsageError({
        message:
          '`texra tasks attach` prints text or NDJSON (`--output-format ndjson`), not JSON.',
      });
    return Effect.gen(function* () {
      const client = yield* serviceClient;
      const task = yield* taskNamed(client, input.id);
      const outcome = yield* attachTask(client, task, {
        format: context.outputFormat === 'ndjson' ? 'ndjson' : 'text',
        columns: context.stdoutIsTty
          ? (getStdoutColumns() ?? PIPED_COLUMNS)
          : PIPED_COLUMNS,
        color: context.stdoutColorEnabled,
      });
      if (outcome !== null) return runOutcomeExitCode(outcome);
      writeTextStderr(
        `Task ${task.runId} has not ended, and no TeXRA service is running it: the process that ran it stopped. Nothing more will come from it until it is resumed. \`texra tasks send ${task.runId} "<text>"\` continues it.`,
      );
      return CliExitCode.AgentError;
    }).pipe(Effect.scoped);
  },
});

const startCommand = cliCommand('start', {
  description: 'Start an agent as a task in the TeXRA service and print its id',
  config: {
    agent: Argument.String('agent').pipe(
      Argument.withDescription('Agent name from `texra agents list`'),
    ),
    instruction: Flag.String('instruction').pipe(
      Flag.withDescription('What the agent should do'),
    ),
    model: modelFlag('Model for the agent'),
  },
  platform: { startsService: true },
  catchExitCode: CliExitCode.AgentError,
  run: Effect.fn('tasks.run')(function* (context, input) {
    const instruction = input.instruction.trim();
    if (!instruction)
      return yield* new CliUsageError({
        message: '--instruction must not be empty.',
      });
    const services = yield* cliPlatform;
    // A task starts in the service only: a command that holds none fails
    // with why.
    yield* Effect.fromResult(services.service);
    // The task runs in the service under the project's persisted policy,
    // with what this command asked for riding the launch
    // (`launchApproval`).
    const requested = context.requestedApprovalPolicy;
    const refused = launchApprovalNotice(
      requested,
      projectApprovalPolicy(services.config),
    );
    if (refused !== undefined) writeTextStderr(refused);
    const agent = yield* resolveCliRunAgent(services, input.agent);
    const model = yield* selectCliRunModel(
      context,
      Option.getOrUndefined(input.model),
      'chat',
      services,
    );
    const payload: AgentConfigPayload = {
      agent: input.agent,
      agentSource: { kind: agent.source },
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
    // Started through the project's session in the service, as a window
    // starts one; this terminal's provider keys go with it.
    const session = yield* services.runSession;
    const { runId } = yield* session.start({
      config,
      approval: launchApproval(requested),
    });
    yield* emitCliResult(
      cliResult('task', { runId, workspace: context.cwd }, runId),
    );
  }),
});

const sendCommand = cliCommand('send', {
  description: 'Send a running task a follow-up',
  config: {
    id: TASK_ID_ARG,
    text: Argument.String('text').pipe(
      Argument.withDescription('The follow-up message'),
    ),
  },
  platform: { startsService: true },
  catchExitCode: CliExitCode.AgentError,
  run: (_, input) =>
    requestTask(input.id, (runId) => ({
      kind: 'followUp.send',
      runId,
      text: input.text,
    })).pipe(
      Effect.flatMap(({ task, outcome }) => {
        const { status } = outcome;
        return emitCliResult(
          cliResult(
            'task',
            { runId: task.runId, status },
            `Follow-up ${status} to ${task.runId}.`,
          ),
        );
      }),
    ),
});

const stopCommand = cliCommand('stop', {
  description: 'Stop a running task; it can be resumed later',
  config: { id: TASK_ID_ARG },
  platform: { startsService: true },
  catchExitCode: CliExitCode.AgentError,
  run: (_, input) =>
    requestTask(input.id, (runId) => ({
      kind: 'run.stop',
      runId,
      reason: 'user',
    })).pipe(
      Effect.flatMap(({ task }) =>
        emitCliResult(
          cliResult(
            'task',
            { runId: task.runId, stopped: true },
            `Stopped ${task.runId}.`,
          ),
        ),
      ),
    ),
});

export const tasksCommand = Command.make('tasks').pipe(
  Command.withDescription(
    'List, start, follow and steer the tasks the TeXRA service runs for every window',
  ),
  Command.withSubcommands([
    listCommand,
    startCommand,
    attachCommand,
    sendCommand,
    stopCommand,
  ]),
);
