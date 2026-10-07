import { defineCommand } from 'citty';
import { Deferred, Effect, Exit, Schedule, Scope } from 'effect';

import { SessionOwner } from '@texra-ai/harness';
import { entryChannel, entryMessage, setLogSink } from '@logger/logSink';
import { adoptLoginShellEnvironment } from '@platform/defaults/loginShellEnv';
import { askServiceToStop } from '@texra/controllers/server/client';
import { servicePaths } from '@texra/controllers/server/discovery';
import { ServiceProjects } from '@texra/controllers/server/handlers';
import { serve } from '@texra/controllers/server/serve';
import type { ServiceInfo } from '@texra/controllers/server/protocol';

import { CliUsageError, type CliContext } from '../runtime/cliContext';
import {
  cliServiceProjects,
  connectCliService,
  probeCliService,
} from '../runtime/cliService';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStderr } from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';

/** How long a service with no client and no running task stays up. */
const DEFAULT_IDLE_SECONDS = 600;
/** How long `stop` waits for the service to go. */
const STOP_TIMEOUT = '30 seconds';

function parseIdleSeconds(value: unknown): number {
  if (value === undefined) return DEFAULT_IDLE_SECONDS;
  const seconds = Number(value);
  if (typeof value !== 'string' || !Number.isInteger(seconds) || seconds < 1)
    throw new CliUsageError(
      `--idle-timeout expects a whole number of seconds, got ${String(value)}.`,
    );
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
            `${new Date().toISOString()} ${String(entry.level)} ${channel ? `[${channel}] ` : ''}${entryMessage(entry)}`,
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
function runServe(context: CliContext, idleSeconds: number) {
  return Effect.gen(function* () {
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
    const onSignal = () => Deferred.doneUnsafe(shutdown, Exit.void);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const scope = yield* Scope.make();
    const owner = yield* SessionOwner;
    const served = Effect.gen(function* () {
      const projects = yield* cliServiceProjects(context, scope);
      return yield* serve({
        idleAfter: `${idleSeconds} seconds`,
        shutdown,
        settle: Effect.asVoid(owner.closeAll),
      }).pipe(Effect.provideService(ServiceProjects, projects));
    }).pipe(
      // The sessions close first, their runs stopped and settled; then the
      // stores their roots opened.
      Effect.ensuring(
        owner.closeAll.pipe(Effect.andThen(Scope.close(scope, Exit.void))),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
        }),
      ),
    );
    return yield* served.pipe(
      Effect.as(CliExitCode.Success),
      Effect.catchTag(
        ['ServiceAlreadyRunning', 'ServiceUnavailable'],
        (error) =>
          Effect.sync(() => {
            writeTextStderr(error.message);
            return CliExitCode.Usage;
          }),
      ),
    );
  });
}

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
      description: `Exit after this long with no client and no running task (default ${DEFAULT_IDLE_SECONDS})`,
    },
  },
  catchExitCode: CliExitCode.AgentError,
  run: (context, ctx) =>
    runServe(context, parseIdleSeconds(ctx.args['idle-timeout'])),
});

function statusText(info: ServiceInfo | null, context: CliContext): string {
  if (info === null)
    return `No TeXRA service is running (${servicePaths(context.storageRoot).record}).`;
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

function emitStatus(context: CliContext, info: ServiceInfo | null): void {
  const service = { ...info, online: info !== null };
  emitCliResult(context, {
    json: service,
    ndjson: { kind: 'service', service },
    text: statusText(info, context),
  });
}

/** Ask the service to stop and wait until it no longer answers. */
function stopService(context: CliContext) {
  return Effect.gen(function* () {
    const info = yield* probeCliService(context.storageRoot);
    if (info === null) return null;
    yield* askServiceToStop(info.socket, false);
    yield* probeCliService(context.storageRoot).pipe(
      Effect.flatMap((answer) =>
        answer === null ? Effect.void : Effect.fail('running' as const),
      ),
      Effect.retry(Schedule.spaced('200 millis')),
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
}

const statusCommand = defineCliCommand({
  meta: { name: 'status', description: 'Show whether the TeXRA service runs' },
  args: { ...GLOBAL_ARGS },
  catchExitCode: CliExitCode.AgentError,
  run: (context) =>
    probeCliService(context.storageRoot).pipe(
      Effect.map((info) => {
        emitStatus(context, info);
        return CliExitCode.Success;
      }),
    ),
});

const stopCommand = defineCliCommand({
  meta: {
    name: 'stop',
    description:
      'Stop the TeXRA service; its running tasks stop and can be resumed',
  },
  args: { ...GLOBAL_ARGS },
  catchExitCode: CliExitCode.AgentError,
  run: (context) =>
    stopService(context).pipe(
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
  catchExitCode: CliExitCode.AgentError,
  run: (context) =>
    Effect.gen(function* () {
      yield* stopService(context);
      const { info } = yield* Effect.scoped(
        connectCliService(context.storageRoot),
      );
      emitStatus(context, info);
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
