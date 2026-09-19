import { Effect, Result } from 'effect';

import { withProcessServices } from '@platform/processRuntime';
import { usageLoggingOptOut } from '@telemetry/UsageLogService';
import {
  buildDoctorReport,
  doctorExitCode,
  writeDoctorReport,
  type DoctorReport,
} from '../runtime/doctor';
import { initCliPlatform } from '../runtime/initPlatform';

import { getCliModelAccessList } from '../runtime/modelAccess';
import { getCliAuthProfile } from '../runtime/supabaseAuth';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { suppressCliFetchStackLogs } from './_helpers/fetchSilencer';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

/**
 * The whole command as one program: the init fold and the report it feeds,
 * with no Promise between them.
 */
function doctorReport(context: CliContext): Effect.Effect<DoctorReport> {
  return Effect.gen(function* () {
    // The one step that cannot run on the process runtime, because it is what
    // builds it. Its failure is a row in the report rather than a throw, so it
    // is folded into a Result here and handed to the builder as data.
    const init = yield* Effect.result(
      initCliPlatform({ ...context, quietLogs: true }),
    );
    if (Result.isFailure(init)) {
      // A failed init disposed the runtime it installed (see
      // `initPlatform.ts`), so the degraded report — node, workspace,
      // resources, LaTeX, config and the platform-failure row — renders with
      // nothing provided. It reads no service and nothing in it logs through
      // Effect.
      return yield* buildDoctorReport(context, {}, init.failure);
    }
    const services = init.success;
    // Consent is read from the workspace configuration the init installed;
    // without it the telemetry check reports the gap.
    const roots = services.roots;
    // The healthy report settles on the root's own context — the provision
    // `services.runtime.runPromise` made before this became one program — so
    // the availability read takes the process's `LanguageModel` port from it
    // and the account read's Effect logs reach the CLI's own sink.
    return yield* withProcessServices(
      services.runtime,
      buildDoctorReport(context, {
        authProfile: getCliAuthProfile(),
        modelAccessList: withProcessServices(
          services.runtime,
          getCliModelAccessList({ stores: services }),
        ),
        ...(roots && {
          usageLoggingOptOut: () => usageLoggingOptOut(roots.config),
        }),
      }),
    );
  });
}

async function runDoctor(context: CliContext): Promise<number> {
  // The command's one run, and the CLI's one pinned no-runtime run
  // (`BARE_EFFECT_RUN_SITES` in dependencyDirection.vitest.ts): the program
  // starts before the process runtime exists and, on the failed-init path,
  // ends with that runtime already disposed, so it can borrow none.
  const report = await suppressCliFetchStackLogs(() =>
    Effect.runPromise(doctorReport(context)),
  );
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
