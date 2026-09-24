import { defineCommand } from 'citty';
import { Cause, Effect, Exit } from 'effect';

import { nodeFileServices } from '@platform/defaults/jsonStore';
import { withProcessServices } from '@platform/processRuntime';
import { usageLoggingOptOut } from '@telemetry/UsageLogService';
import { ensureError } from '@utils/errors/errorMessage';
import {
  buildDoctorReport,
  doctorExitCode,
  writeDoctorReport,
  type DoctorReport,
} from '../runtime/doctor';
import { initCliPlatform } from '../runtime/initPlatform';

import { getCliModelAccessList } from '../runtime/modelAccess';
import { getCliAuthProfile } from '../runtime/supabaseAuth';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
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
    // builds it. Its failure is a row in the report rather than a throw, so
    // it is folded here and handed to the builder as data — over the whole
    // cause, because a platform that dies on the way up is as much "no
    // platform" as one that fails.
    const init = yield* Effect.exit(
      initCliPlatform({ ...context, quietLogs: true }),
    );
    if (Exit.isFailure(init)) {
      // A failed init disposed the runtime it installed (see
      // `initPlatform.ts`), so the degraded report — node, workspace,
      // resources, LaTeX, config and the platform-failure row — renders
      // without it. It reads only the Node filesystem, which it provides
      // itself, and nothing in it logs through Effect.
      return yield* buildDoctorReport(
        context,
        {},
        ensureError(Cause.squash(init.cause)),
      ).pipe(Effect.provide(nodeFileServices));
    }
    const services = init.value;
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
        // Consent is read from the workspace configuration the init
        // installed.
        usageLoggingOptOut: () => usageLoggingOptOut(services.roots.config),
      }),
    );
  });
}

async function runDoctor(context: CliContext): Promise<number> {
  // The command's one run, and the CLI's one pinned no-runtime run
  // (`BARE_EFFECT_RUN_SITES` in dependencyDirection.vitest.ts): the program
  // starts before the process runtime exists and, on the failed-init path,
  // ends with that runtime already disposed, so it can borrow none.
  const report = await Effect.runPromise(
    suppressCliFetchStackLogs(doctorReport(context)),
  );
  writeDoctorReport(context, report);
  return doctorExitCode(report);
}

export const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Check CLI runtime dependencies' },
  args: {
    ...GLOBAL_ARGS,
  },
  // The one command that cannot take `defineCliCommand`: that helper installs
  // the process runtime and runs the command's program on it, and this report
  // can borrow a runtime at neither end — none exists when the init fold
  // begins, and an init that fails disposes the one it installed before it
  // re-raises. So the `contextFromArgs` → `setExitCode` fold stays here.
  async run(ctx) {
    const context = await contextFromArgs(ctx.args, ctx.rawArgs);
    setExitCode(await runDoctor(context));
  },
});
