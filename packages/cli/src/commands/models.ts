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

type ModelAccessList = Awaited<ReturnType<typeof getCliModelAccessList>>;
type ModelAccessEntry = ModelAccessList[number];

async function loadModelAccessList(
  context: CliContext,
): Promise<ModelAccessList | { error: string }> {
  try {
    return await suppressCliFetchStackLogs(async () => {
      await initCliPlatform({ ...context, quietLogs: true });
      return getCliModelAccessList();
    });
  } catch (error) {
    return { error: formatCliModelListError(error) };
  }
}

async function listModels(context: CliContext): Promise<number> {
  const result = await loadModelAccessList(context);
  if ('error' in result) {
    writeTextStderr(result.error);
    return CliExitCode.ModelOrNetworkError;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(
      JSON.stringify(
        result.map(({ model }) => model),
        null,
        2,
      ),
    );
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const { model } of result) {
      writeNdjsonStdout({ kind: 'model', ts, model });
    }
    return CliExitCode.Success;
  }

  for (const { model, status } of result) {
    writeTextStdout(`${model.value}\t${model.label}\t${status}`);
  }
  return CliExitCode.Success;
}

function findModelById(
  list: ModelAccessList,
  id: string,
): ModelAccessEntry | undefined {
  const direct = list.find((entry) => entry.model.value === id);
  if (direct) return direct;
  const lower = id.toLowerCase();
  return list.find((entry) => entry.model.value.toLowerCase() === lower);
}

function formatModelDetails(entry: ModelAccessEntry): string {
  const { model, status } = entry;
  const lines: string[] = [];
  lines.push(`id: ${model.value}`);
  lines.push(`label: ${model.label}`);
  lines.push(`provider: ${model.provider}`);
  lines.push(`status: ${status}`);
  lines.push(`availability: ${model.availabilityLabel}`);
  if (model.context) lines.push(`context: ${model.context}`);
  if (model.cost) lines.push(`cost: ${model.cost}`);
  if (model.hint) {
    lines.push('');
    lines.push(model.hint);
  }
  return lines.join('\n');
}

async function showModel(context: CliContext, id: string): Promise<number> {
  const result = await loadModelAccessList(context);
  if ('error' in result) {
    writeTextStderr(result.error);
    return CliExitCode.ModelOrNetworkError;
  }

  const entry = findModelById(result, id);
  if (!entry) {
    writeTextStderr(`Model not found: ${id}`);
    return CliExitCode.Usage;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(entry.model, null, 2));
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'model',
      ts: new Date().toISOString(),
      model: entry.model,
    });
    return CliExitCode.Success;
  }

  writeTextStdout(formatModelDetails(entry));
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

const modelsShowCommand = defineCommand({
  meta: { name: 'show', description: 'Show one model' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Model id from `texra models list` (case-insensitive)',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await showModel(context, ctx.args.id));
  },
});

export const modelsCommand = defineCommand({
  meta: { name: 'models', description: 'Inspect TeXRA models' },
  subCommands: {
    list: modelsListCommand,
    show: modelsShowCommand,
  },
});
