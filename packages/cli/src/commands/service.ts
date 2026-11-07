import { defineCommand } from 'citty';
import { Deferred, Effect, Exit } from 'effect';

import { Sessions } from '@texra-ai/harness';
import { entryChannel, entryMessage, setLogSink } from '@texra-ai/harness/node';
import { holdSignals } from '@cli/runtime/processSignals';
import { stopService } from '@texra/controllers/server/client';
import { servicePaths } from '@texra/controllers/server/discovery';
import { ServiceProjects } from '@texra/controllers/server/handlers';
import { serve } from '@texra/controllers/server/serve';
import { PROTOCOL, type ServiceInfo } from '@texra/controllers/server/protocol';

import {
  adoptLoginShellEnvironment,
  CliInvocation,
  CliUsageError,
  type CliContext,
} from '../runtime/cliContext';
import {
  cliServiceProjects,
  isLinked,
  linkCliService,
  probeCliService,
} from '../runtime/cliService';
import { cliProcessLayer } from '../runtime/cliProcessRuntime';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStderr } from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';

/** How long a service with no project open stays up. */
const DEFAULT_IDLE_SECONDS = 600;
/** How long `stop` waits for the service to go. */
const STOP_TIMEOUT = '30 seconds';

function parseIdleSeconds(value: unknown): number {
  if (value === undefined) return DEFAULT_IDLE_SECONDS;
  const seconds = Number(value);
  if (typeof value !== 'string' || !Number.isInteger(seconds) || seconds < 1)
    throw new CliUsageError({
      message: `--idle-timeout expects a whole number of seconds, got ${String(value)}.`,
    });
  return seconds;
}

/** Every service log line is `time LEVEL [channel] message` on stderr, which
 *  a detached service has pointed at `run/serve.log`. */
function installServiceLogSink(): void {
  setLogSink(
    {
      write(entry) {
        const channel = entryChannel(entry);
        const data = entry.annotations.data;
        writeTextStderr(
          [
            `${entry.timestamp} ${String(entry.level)} ${channel ? `[${channel}] ` : ''}${entryMessage(entry)}`,
            // The cause and payload a warning carries are what makes a
            // service log answerable after the fact.
            ...(entry.cause === undefined
              ? []
              : [`  cause: ${String(entry.cause)}`]),
            ...(data === undefined
              ? []
              : [
                  `  data: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
                ]),
          ].join('\n'),
        );
      },
    },
    { trusted: true },
  );
}

/** Serve until the service ends, closing every session it opened. */
const runServe = Effect.fn('runServe')(function* (
  context: CliContext,
  idleSeconds: number,
) {
  installServiceLogSink();
  // Whoever started it, the service runs with the user's login-shell
  // environment, so every window finds the same tools.
  yield* adoptLoginShellEnvironment().pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `${error.message}; tasks run with only HOME and the TEXRA_* settings the service was started with, so tools such as latexmk and git may not be found`,
      ),
    ),
  );
  const shutdown = yield* Deferred.make<void>();
  const sessions = yield* Sessions;
  const served = Effect.gen(function* () {
    const onSignal = () => Deferred.doneUnsafe(shutdown, Exit.void);
    yield* Effect.acquireRelease(
      Effect.sync(() => holdSignals({ SIGINT: onSignal, SIGTERM: onSignal })),
      (release) => Effect.sync(release),
    );
    // The stores the projects' roots open live in this scope.
    const projects = yield* cliServiceProjects(
      context,
      yield* Effect.scope,
      sessions,
      `${idleSeconds} seconds`,
    );
    return yield* serve({
      idleAfter: `${idleSeconds} seconds`,
      shutdown,
      settle: Effect.asVoid(sessions.closeAll),
    }).pipe(Effect.provideService(ServiceProjects, projects));
  }).pipe(Effect.scoped);
  return yield* served.pipe(
    Effect.as(CliExitCode.Success),
    // Another service of this root listens: a normal outcome of two
    // clients starting one at once, said in the log and exited clean.
    Effect.catchTag('ServiceAlreadyRunning', (error) =>
      Effect.sync(() => {
        writeTextStderr(error.message);
        return CliExitCode.Success;
      }),
    ),
    Effect.catchTag('ServiceUnavailable', (error) =>
      Effect.sync(() => {
        writeTextStderr(error.message);
        return CliExitCode.AgentError;
      }),
    ),
  );
});

export const serveCommand = defineCliCommand({
  meta: {
    name: 'serve',
    description:
      'Run the TeXRA service in the foreground (windows start it on their own)',
  },
  args: {
    ...GLOBAL_ARGS,
    'idle-timeout': {
      type: 'string',
      valueHint: 'seconds',
      description: `Exit after this long with no project open and no task starting, and close a project's session after this long with no client and no task of its own (default ${DEFAULT_IDLE_SECONDS})`,
    },
  },
  catchExitCode: CliExitCode.AgentError,
  layer: cliProcessLayer,
  run: (context, ctx) =>
    runServe(context, parseIdleSeconds(ctx.args['idle-timeout'])),
});

function statusText(info: ServiceInfo | null, context: CliContext): string {
  if (info === null)
    return `No TeXRA service is running for ${context.storageRoot}.`;
  return [
    `TeXRA service ${info.version} (protocol ${info.protocol})`,
    `  pid:      ${info.pid}`,
    `  socket:   ${info.socket}`,
    `  started:  ${new Date(info.startedAt).toISOString()}`,
    `  clients:  ${info.clients}`,
    `  running:  ${info.running} task${info.running === 1 ? '' : 's'}${info.draining ? ' (draining)' : ''}`,
    `  log:      ${servicePaths(context.storageRoot).log}`,
  ].join('\n');
}

const emitStatus = (info: ServiceInfo | null) =>
  CliInvocation.use(({ context }) => {
    const service = { ...info, online: info !== null };
    return emitCliResult({
      json: service,
      ndjson: { kind: 'service', service },
      text: statusText(info, context),
    });
  });

/** Ask the service to stop and wait until it is gone: its socket closes
 *  as it exits. */
const stopRunningService = Effect.gen(function* () {
  // A service this build cannot speak to still takes the stop, the one
  // procedure every build keeps.
  const info = yield* probeCliService.pipe(
    Effect.catchIf(
      (error) => error.unspoken !== undefined,
      (error) =>
        Effect.as(stopService(error.unspoken ?? '', false), null).pipe(
          Effect.mapError(
            (failure) =>
              new Error(`The TeXRA service did not stop: ${failure.message}`),
          ),
        ),
    ),
  );
  if (info === null) return null;
  yield* stopService(info.socket, false).pipe(
    Effect.timeout(STOP_TIMEOUT),
    Effect.mapError(
      () =>
        new Error(
          `The TeXRA service (pid ${info.pid}) did not stop within ${STOP_TIMEOUT}.`,
        ),
    ),
  );
  return info;
});

const statusCommand = defineCliCommand({
  meta: { name: 'status', description: 'Show whether the TeXRA service runs' },
  args: { ...GLOBAL_ARGS },
  layer: cliProcessLayer,
  catchExitCode: CliExitCode.AgentError,
  run: () =>
    probeCliService.pipe(
      Effect.flatMap(emitStatus),
      Effect.as(CliExitCode.Success),
    ),
});

const stopCommand = defineCliCommand({
  meta: {
    name: 'stop',
    description:
      'Stop the TeXRA service; its running tasks stop and can be resumed',
  },
  args: { ...GLOBAL_ARGS },
  layer: cliProcessLayer,
  catchExitCode: CliExitCode.AgentError,
  run: () =>
    stopRunningService.pipe(
      Effect.map((stopped) => {
        writeTextStderr(
          stopped === null
            ? 'No TeXRA service was running.'
            : `Stopped the TeXRA service (pid ${stopped.pid}).`,
        );
        return CliExitCode.Success;
      }),
    ),
});

const restartCommand = defineCliCommand({
  meta: { name: 'restart', description: 'Stop the TeXRA service and start it' },
  args: { ...GLOBAL_ARGS },
  layer: cliProcessLayer,
  catchExitCode: CliExitCode.AgentError,
  run: Effect.fn('service.run')(function* (context) {
    yield* stopRunningService;
    // The one door, starting the service: its hello is the status shown.
    const info = yield* Effect.scoped(
      Effect.flatMap(linkCliService(context.storageRoot, true), (link) =>
        isLinked(link)
          ? Effect.flatMap(link.client.get, (client) =>
              client === null
                ? Effect.fail(new Error('The TeXRA service is not linked.'))
                : client['service.hello']({ protocol: PROTOCOL.digest }),
            )
          : Effect.fail(new Error(link.none)),
      ),
    );
    yield* emitStatus(info);
    return CliExitCode.Success;
  }),
});

export const serviceCommand = defineCommand({
  meta: {
    name: 'service',
    description: 'Manage the TeXRA service that runs tasks for every window',
  },
  subCommands: {
    status: statusCommand,
    stop: stopCommand,
    restart: restartCommand,
  },
});
