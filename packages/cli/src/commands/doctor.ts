import { Effect } from 'effect';
import { Command, Flag } from 'effect/cli';

import { withProcessServices } from '@texra-ai/harness/host';
import { ensureError } from '@texra-ai/harness/schemas';
import { nodePlatformServices, setLogSink } from '@texra-ai/harness/node';
import { usageLoggingOptOut } from '@telemetry/UsageLogService';
import {
  buildDoctorReport,
  doctorExitCode,
  writeDoctorReport,
  type DoctorReport,
} from '../runtime/doctor';
import { makeCliProcessRuntime } from '../runtime/platform/cliProcessRuntime';
import { silentLogSink } from '../runtime/platform/logSinks';
import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import { pruneStorage } from '../runtime/pruneStorage';

import { loadModelOptions } from '@texra/model/setupCredentialAccess';

import { loadConfigAndWarn } from './_helpers/loadConfigAndWarn';
import {
  readCliGlobalArgs,
  selectCliCommand,
  selectExitCode,
} from './_helpers/cliCommand';
import type { CliContext } from '../runtime/platform/cliContext';

/** The healthy report, on the command's runtime once its platform is up. */
const readyReport = (context: CliContext) =>
  Effect.flatMap(cliPlatform, (services) =>
    buildDoctorReport(context, {
      kind: 'ready',
      modelAccessList: withProcessServices(
        services.runtime,
        loadModelOptions(services),
      ),
      // Consent is read from the workspace configuration the platform
      // opened.
      usageLoggingOptOut: withProcessServices(
        services.runtime,
        usageLoggingOptOut(services.roots.config),
      ),
    }),
  );

/**
 * The whole report. A runtime or platform that fails to come up is a row in
 * the report rather than a throw, so it is caught here over the whole cause
 * (one that dies on the way up is as much "no platform" as one that fails),
 * once the runtime is disposed: the degraded report — node, workspace,
 * resources, LaTeX, config and the platform-failure row — renders with only
 * the Node platform services its LaTeX probes spawn on, and nothing in it
 * logs through Effect.
 */
const doctorReport = (context: CliContext): Effect.Effect<DoctorReport> =>
  // A build that throws needs no failure of its own: it dies here, and the
  // report below is made from the whole cause.
  Effect.sync(() => {
    // The report is the whole output and names every failure, so the
    // runtime's log lines go nowhere from its build on.
    setLogSink(silentLogSink, { trusted: true });
    return makeCliProcessRuntime(context);
  }).pipe(
    Effect.flatMap((runtime) =>
      Effect.promise(() => runtime.runPromiseExit(readyReport(context))).pipe(
        Effect.ensuring(runtime.disposeEffect),
      ),
    ),
    Effect.flatten,
    Effect.catchCause((cause) =>
      buildDoctorReport(context, {
        kind: 'degraded',
        initError: ensureError(cause),
      }).pipe(Effect.provide(nodePlatformServices)),
    ),
  );

const DOCTOR_CONFIG = {
  pruneStorage: Flag.Boolean('prune-storage').pipe(
    Flag.withoutNegation,
    Flag.withDefault(false),
    Flag.withDescription(
      'List the workspace stores whose project is gone and the aside copies of session stores, and delete them once confirmed',
    ),
  ),
  yes: Flag.Boolean('yes').pipe(
    Flag.withoutNegation,
    Flag.withDefault(false),
    Flag.withAlias('y'),
    Flag.withDescription('Delete what --prune-storage lists without asking'),
  ),
};

/** `--prune-storage` is a program on the process runtime, which reads the
 *  global root's store records. */
const pruneStorageCommand = selectCliCommand('doctor', {
  description: 'Delete the stores whose project is gone',
  config: DOCTOR_CONFIG,
  run: (context, input) => pruneStorage(context, input.yes),
  catchExitCode: CliExitCode.ModelOrNetworkError,
});

// The report is not a command program: a runtime that fails to build is a
// row of it, so it builds and disposes that runtime itself, in the parse.
export const doctorCommand = Command.make('doctor', DOCTOR_CONFIG, (input) =>
  input.pruneStorage
    ? pruneStorageCommand(input)
    : Effect.gen(function* () {
        const context = yield* loadConfigAndWarn(yield* readCliGlobalArgs(), {
          printConfigWarnings: false,
        });
        const report = yield* doctorReport(context);
        writeDoctorReport(context, report);
        yield* selectExitCode(doctorExitCode(report));
      }),
).pipe(Command.withDescription('Check CLI runtime dependencies'));
