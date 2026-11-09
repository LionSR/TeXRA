import { defineCommand } from 'citty';
import { Cause, Effect } from 'effect';

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

import { getCliModelAccessList } from '../runtime/models/modelAccess';

import { loadConfigAndWarn } from './_helpers/loadConfigAndWarn';
import { defineCliCommand } from './_helpers/defineCliCommand';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/platform/cliContext';

/** The healthy report, on the command's runtime once its platform is up. */
const readyReport = (context: CliContext) =>
  Effect.flatMap(cliPlatform, (services) =>
    buildDoctorReport(context, {
      kind: 'ready',
      modelAccessList: withProcessServices(
        services.runtime,
        getCliModelAccessList({ stores: services }),
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
  Effect.try({
    try: () => {
      // The report is the whole output, so the runtime's log lines go nowhere
      // from its build on, as a platform's do.
      setLogSink(silentLogSink, { trusted: true });
      return makeCliProcessRuntime(context);
    },
    catch: ensureError,
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
        initError: ensureError(Cause.squash(cause)),
      }).pipe(Effect.provide(nodePlatformServices)),
    ),
  );

const DOCTOR_ARGS = {
  ...GLOBAL_ARGS,
  'prune-storage': {
    type: 'boolean',
    description:
      'List the workspace stores whose project is gone and the aside copies of session stores, and delete them once confirmed',
  },
  yes: {
    type: 'boolean',
    alias: 'y',
    description: 'Delete what --prune-storage lists without asking',
  },
} as const;

/** `--prune-storage` is a program on the process runtime, which reads the
 *  global root's store records: the one case of this command that can take
 *  `defineCliCommand`. */
const pruneStorageCommand = defineCliCommand({
  meta: { name: 'doctor' },
  args: DOCTOR_ARGS,
  run: (context, ctx) => pruneStorage(context, ctx.args.yes === true),
  catchExitCode: CliExitCode.ModelOrNetworkError,
});

export const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Check CLI runtime dependencies' },
  args: DOCTOR_ARGS,
  // The one command that cannot take `defineCliCommand`: that helper reports
  // a runtime that fails to build as a failure, where this command reports it
  // as a row of its report.
  async run(ctx) {
    if (ctx.args['prune-storage'] === true)
      return pruneStorageCommand.run?.(ctx);
    setExitCode(
      await Effect.runPromise(
        Effect.gen(function* () {
          const context = yield* loadConfigAndWarn(ctx.args, ctx.rawArgs, {
            printConfigWarnings: false,
          });
          const report = yield* doctorReport(context);
          writeDoctorReport(context, report);
          return doctorExitCode(report);
        }),
      ),
    );
  },
});
