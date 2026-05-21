import { defineCommand } from 'citty';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import { getCliModelAccessList } from '../runtime/modelAccess';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import {
  formatCliModelListError,
  suppressCliFetchStackLogs,
} from './_helpers/fetchSilencer';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

async function listModels(context: CliContext): Promise<number> {
  let modelAccess: Awaited<ReturnType<typeof getCliModelAccessList>>;
  try {
    modelAccess = await suppressCliFetchStackLogs(async () => {
      await initCliPlatform({ ...context, quietLogs: true });
      return getCliModelAccessList();
    });
  } catch (error) {
    writeTextStderr(formatCliModelListError(error));
    return CliExitCode.ModelOrNetworkError;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(
      JSON.stringify(
        modelAccess.map(({ model }) => model),
        null,
        2,
      ),
    );
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const { model } of modelAccess) {
      writeNdjsonStdout({ kind: 'model', ts, model });
    }
    return CliExitCode.Success;
  }

  for (const { model, status } of modelAccess) {
    writeTextStdout(`${model.value}\t${model.label}\t${status}`);
  }
  return CliExitCode.Success;
}

const modelsListCommand = defineCommand({
  meta: { name: 'list', description: 'List available models' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await listModels(context));
  },
});

export const modelsCommand = defineCommand({
  meta: { name: 'models', description: 'Inspect TeXRA models' },
  subCommands: { list: modelsListCommand },
});
