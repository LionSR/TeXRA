import { Effect, Result } from 'effect';

import { usageLoggingOptOut } from '@telemetry/UsageLogService';
import { ensureError } from '@utils/errors/errorMessage';
import {
  buildDoctorReport,
  doctorExitCode,
  writeDoctorReport,
} from '../runtime/doctor';
import { initCliPlatform } from '../runtime/initPlatform';

import { getCliModelAccessList } from '../runtime/modelAccess';
import { getCliAuthProfile } from '../runtime/supabaseAuth';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { suppressCliFetchStackLogs } from './_helpers/fetchSilencer';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

async function runDoctor(context: CliContext): Promise<number> {
  // The one step that cannot run on the process runtime, because it is what
  // builds it. Its failure is a row in the report rather than a throw, so it
  // is folded into a Result here and handed to the builder as data. This fold
  // and the degraded report below are the CLI's two pinned no-runtime runs
  // (`BARE_EFFECT_RUN_SITES` in dependencyDirection.vitest.ts).
  const init = await suppressCliFetchStackLogs(() =>
    Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          try: () => initCliPlatform({ ...context, quietLogs: true }),
          catch: ensureError,
        }),
      ),
    ),
  );
  const services = Result.isSuccess(init) ? init.success : undefined;
  // Consent is read from the workspace configuration the init installed;
  // without it the telemetry check reports the gap.
  const roots = services?.roots;
  const report = await suppressCliFetchStackLogs(async () => {
    const program = buildDoctorReport(
      context,
      services
        ? {
            authProfile: getCliAuthProfile(),
            // The availability read takes the process's `LanguageModel` port
            // from context. The root discharges that requirement here, over
            // the very context the healthy report settles on, so the report
            // itself asks for no service — which is what lets the degraded
            // report below render with no runtime at all.
            modelAccessList: getCliModelAccessList({
              stores: services,
            }).pipe(Effect.provide(await services.runtime.context())),
            ...(roots && {
              usageLoggingOptOut: () => usageLoggingOptOut(roots.config),
            }),
          }
        : {},
      Result.isFailure(init) ? init.failure : undefined,
    );
    // The program takes no service, so the runtime only decides where its
    // diagnostics land: the healthy report settles on the root's runtime,
    // where the account read's Effect logs reach the CLI's own sink. A failed
    // init disposed that runtime, and what it leaves to render — the fs and
    // LaTeX probes, none of which log through Effect — settles on the
    // default one.
    return services
      ? services.runtime.runPromise(program)
      : Effect.runPromise(program);
  });
  writeDoctorReport(context, report);
  return doctorExitCode(report);
}

export const doctorCommand = defineCliCommand({
  meta: { name: 'doctor', description: 'Check CLI runtime dependencies' },
  args: {
    ...GLOBAL_ARGS,
  },
  run: runDoctor,
});
