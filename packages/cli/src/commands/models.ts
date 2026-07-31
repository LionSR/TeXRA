import { defineCommand } from 'citty';

import { AgentCategory } from '@shared/schemas/agent';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import { effectiveCliApiMode } from '../runtime/apiAccessMode';
import {
  cliModelRecord,
  formatCliModelDetails,
  getCliModelAccessList,
  formatNoListableModelsMessage,
  listableModelAccessEntries,
  loadCliModelAccessEntry,
  type CliModelListOptions,
} from '../runtime/modelAccess';
import { knownCliModelIds } from '../runtime/cliConfig';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  formatCliModelListError,
  suppressCliFetchStackLogs,
} from './_helpers/fetchSilencer';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

type ModelAccessList = Awaited<ReturnType<typeof getCliModelAccessList>>;

async function loadModelAccessList(
  context: CliContext,
  options: CliModelListOptions = {},
): Promise<
  | { models: ModelAccessList; apiMode: CliContext['apiMode'] }
  | {
      error: string;
    }
> {
  try {
    return await suppressCliFetchStackLogs(async () => {
      await initCliPlatform({ ...context, quietLogs: true });
      const apiMode = effectiveCliApiMode(context);
      const models = await getCliModelAccessList({
        apiMode,
        agentCategory: AgentCategory.ToolUse,
        models:
          options.includeUnavailable === true ? knownCliModelIds() : undefined,
      });
      return { models, apiMode };
    });
  } catch (error) {
    return { error: formatCliModelListError(error) };
  }
}

async function listModels(
  context: CliContext,
  options: CliModelListOptions,
): Promise<number> {
  const result = await loadModelAccessList(context, options);
  if ('error' in result) {
    writeTextStderr(result.error);
    return CliExitCode.ModelOrNetworkError;
  }

  const listedModels = listableModelAccessEntries(result.models, options);
  if (context.outputFormat === 'text' && listedModels.length === 0) {
    writeTextStderr(formatNoListableModelsMessage(result.apiMode, options));
  }
  const records = listedModels.map(({ model }) => cliModelRecord(model));
  emitCliResult(
    context,
    {
      json: records,
      ndjson: records.map((model) => ({ kind: 'model', model })),
      text: listedModels
        .map(({ model, status }) => `${model.value}\t${model.label}\t${status}`)
        .join('\n'),
    },
    { paged: true },
  );
  return CliExitCode.Success;
}

async function showModel(context: CliContext, id: string): Promise<number> {
  const result = await loadModelAccessList(context);
  if ('error' in result) {
    writeTextStderr(result.error);
    return CliExitCode.ModelOrNetworkError;
  }

  let entry: Awaited<ReturnType<typeof loadCliModelAccessEntry>>;
  try {
    entry = await suppressCliFetchStackLogs(() =>
      loadCliModelAccessEntry(id, {
        apiMode: result.apiMode,
        agentCategory: AgentCategory.ToolUse,
        accessList: result.models,
      }),
    );
  } catch (error) {
    writeTextStderr(formatCliModelListError(error));
    return CliExitCode.ModelOrNetworkError;
  }

  if (!entry) {
    writeTextStderr(`Model not found: ${id}`);
    return CliExitCode.Usage;
  }

  const record = cliModelRecord(entry.model);
  emitCliResult(context, {
    json: record,
    ndjson: { kind: 'model', model: record },
    text: formatCliModelDetails(entry, result.apiMode),
  });
  return CliExitCode.Success;
}

const modelsListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List available models' },
  args: {
    ...GLOBAL_ARGS,
    all: {
      type: 'boolean',
      description: 'Include unavailable models with their access status',
    },
  },
  run: (context, ctx) =>
    listModels(context, { includeUnavailable: ctx.args.all === true }),
});

const modelsShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show one model' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Model id from `texra models list` (case-insensitive)',
    },
  },
  run: (context, ctx) => showModel(context, ctx.args.id),
});

export const modelsCommand = defineCommand({
  meta: { name: 'models', description: 'Inspect TeXRA models' },
  subCommands: {
    list: modelsListCommand,
    show: modelsShowCommand,
  },
});
