import { usageLoggingOptOut } from '@telemetry/UsageLogService';
import {
  buildDoctorReport,
  doctorExitCode,
  writeDoctorReport,
} from '../runtime/doctor';
import {
  initCliPlatform,
  type CliPlatformServices,
} from '../runtime/initPlatform';

import { getCliModelAccessList } from '../runtime/modelAccess';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { suppressCliFetchStackLogs } from './_helpers/fetchSilencer';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

async function runDoctor(context: CliContext): Promise<number> {
  let initError: unknown;
  let initialized: CliPlatformServices | undefined;
  try {
    initialized = await suppressCliFetchStackLogs(() =>
      initCliPlatform({ ...context, quietLogs: true }),
    );
  } catch (error) {
    initError = error;
  }
  // A const, so the probe closure below sees the initialized value rather
  // than the reassignable binding's `| undefined`.
  const services = initialized;
  // Consent is read from the workspace configuration the init installed;
  // without it the telemetry check reports the gap.
  const roots = services?.roots;
  const report = await suppressCliFetchStackLogs(() =>
    buildDoctorReport(
      context,
      services
        ? {
            modelAccessList: () => getCliModelAccessList({ stores: services }),
            ...(roots && {
              usageLoggingOptOut: () => usageLoggingOptOut(roots.config),
            }),
          }
        : {},
      initError,
    ),
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
