import {
  buildDoctorReport,
  doctorExitCode,
  writeDoctorReport,
} from '../runtime/doctor';
import { initCliPlatform } from '../runtime/initPlatform';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { suppressCliFetchStackLogs } from './_helpers/fetchSilencer';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

export function doctorPlatformInitContext(context: CliContext) {
  return { ...context, quietLogs: true };
}

async function runDoctor(context: CliContext): Promise<number> {
  let initError: unknown;
  try {
    await suppressCliFetchStackLogs(async () => {
      await initCliPlatform(doctorPlatformInitContext(context));
    });
  } catch (error) {
    initError = error;
  }
  const report = await suppressCliFetchStackLogs(() =>
    buildDoctorReport(context, undefined, initError),
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
