import { defineCommand } from 'citty';

import {
  buildDoctorReport,
  doctorExitCode,
  writeDoctorReport,
} from '../runtime/doctor';
import { initCliPlatform } from '../runtime/initPlatform';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
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
    buildDoctorReport(
      context,
      initError == null
        ? undefined
        : {
            authProfile: async () => {
              throw initError;
            },
            modelAccessList: async () => {
              throw initError;
            },
          },
    ),
  );
  writeDoctorReport(context, report);
  return doctorExitCode(report);
}

export const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Check CLI runtime dependencies' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await runDoctor(context));
  },
});
