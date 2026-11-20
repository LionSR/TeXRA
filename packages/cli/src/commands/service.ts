import { Deferred, Effect, Exit, References } from 'effect';
import { Command, Flag } from 'effect/cli';

import { formatResultCount } from '@texra-ai/harness/schemas';
import { entryChannel, entryMessage, setLogSink } from '@texra-ai/harness/node';
import { holdSignals } from '@cli/runtime/platform/processSignals';
import {
  SERVICE_SUBCOMMAND,
  servicePaths,
} from '@texra/controllers/server/discovery';
import { serve } from '@texra/controllers/server/serve';
import { PROTOCOL, type ServiceInfo } from '@texra/controllers/server/protocol';

import { adoptLoginShellEnvironment } from '@texra/platform/defaults/loginShellEnvironment';

import { CliInvocation, type CliContext } from '../runtime/platform/cliContext';
import { linkCliService } from '../runtime/platform/cliService';
import {
  linkedClient,
  probeRecordedService,
  stopRunningService,
} from '@texra/controllers/server/client';
import { cliProcessLayer } from '../runtime/platform/cliProcessRuntime';
import { CliExitCode } from '../runtime/platform/exitCodes';
import { writeTextStderr } from '../runtime/platform/logSinks';

import { cliCommand } from './_helpers/cliCommand';
import { cliResult, emitCliResult } from './_helpers/output';

/** How long a service with no project open stays up. */
const DEFAULT_IDLE_SECONDS = 600;

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
  const served = Effect.gen(function* () {
    const onSignal = () => Deferred.doneUnsafe(shutdown, Exit.void);
    yield* Effect.acquireRelease(
      Effect.sync(() => holdSignals({ SIGINT: onSignal, SIGTERM: onSignal })),
      (release) => Effect.sync(release),
    );
    return yield* serve({
      storageRoot: context.storageRoot,
      idleAfter: `${idleSeconds} seconds`,
      shutdown,
    });
  }).pipe(Effect.scoped);
  return yield* served.pipe(
    Effect.as(CliExitCode.Success),
    // Another service of this root listens: a normal outcome of two
    // clients starting one at once, said in the log and exited clean.
    Effect.catchTag('ServiceAlreadyRunning', (error) =>
      Effect.sync(() => {
        writeTextStderr(error.message);
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

export const serveCommand = cliCommand(SERVICE_SUBCOMMAND, {
  description:
    'Run the TeXRA service in the foreground (windows start it on their own)',
  config: {
    idleTimeout: Flag.Int('idle-timeout').pipe(
      Flag.filter(
        (seconds) => seconds >= 1,
        (seconds) => `Expected at least 1 second, got ${seconds}`,
      ),
      Flag.withMetavar('seconds'),
      Flag.withDescription(
        `Exit after this long with no project open and no task starting, and close a project's session after this long with no client and no task of its own (default ${DEFAULT_IDLE_SECONDS})`,
      ),
      Flag.withDefault(DEFAULT_IDLE_SECONDS),
    ),
  },
  catchExitCode: CliExitCode.AgentError,
  layer: cliProcessLayer,
  run: (context, input) =>
    runServe(context, input.idleTimeout).pipe(
      // The service's log is read after the fact, so by default it keeps the
      // info lines a one-shot command's default level drops.
      Effect.provideService(
        References.MinimumLogLevel,
        context.minimumLogLevel === 'Warn' ? 'Info' : context.minimumLogLevel,
      ),
    ),
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
    `  running:  ${formatResultCount(info.running, 'task')}${info.draining ? ' (draining)' : ''}`,
    `  log:      ${servicePaths(context.storageRoot).log}`,
  ].join('\n');
}

const emitStatus = (info: ServiceInfo | null) =>
  CliInvocation.use(({ context }) => {
    const service = { ...info, online: info !== null };
    return emitCliResult(
      cliResult('service', service, statusText(info, context)),
    );
  });

const statusCommand = cliCommand('status', {
  description: 'Show whether the TeXRA service runs',
  config: {},
  layer: cliProcessLayer,
  catchExitCode: CliExitCode.AgentError,
  run: () =>
    probeRecordedService.pipe(
      Effect.flatMap(emitStatus),
      Effect.as(CliExitCode.Success),
    ),
});

const stopCommand = cliCommand('stop', {
  description:
    'Stop the TeXRA service; its running tasks stop and can be resumed',
  config: {},
  layer: cliProcessLayer,
  catchExitCode: CliExitCode.AgentError,
  run: () =>
    stopRunningService.pipe(
      Effect.map((stopped) => {
        writeTextStderr(
          stopped === null
            ? 'No TeXRA service was running.'
            : stopped.pid === undefined
              ? 'Stopped the TeXRA service.'
              : `Stopped the TeXRA service (pid ${stopped.pid}).`,
        );
      }),
    ),
});

const restartCommand = cliCommand('restart', {
  description: 'Stop the TeXRA service and start it',
  config: {},
  layer: cliProcessLayer,
  catchExitCode: CliExitCode.AgentError,
  run: Effect.fn('service.run')(function* (context) {
    yield* stopRunningService;
    // The one door, starting the service: its hello is the status shown.
    const info = yield* Effect.scoped(
      Effect.gen(function* () {
        const link = yield* linkCliService(context.storageRoot, true);
        const client = yield* linkedClient(link);
        return yield* client['service.hello']({ protocol: PROTOCOL.digest });
      }),
    );
    yield* emitStatus(info);
  }),
});

export const serviceCommand = Command.make('service').pipe(
  Command.withDescription(
    'Manage the TeXRA service that runs tasks for every window',
  ),
  Command.withSubcommands([statusCommand, stopCommand, restartCommand]),
);
