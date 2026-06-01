import { defineCommand } from 'citty';

import type { ModelOptionData } from '@shared/schemas';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import { getCliModelAccessList } from '../runtime/modelAccess';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  formatCliModelListError,
  suppressCliFetchStackLogs,
} from './_helpers/fetchSilencer';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

type ModelAccessList = Awaited<ReturnType<typeof getCliModelAccessList>>;
type ModelAccessEntry = ModelAccessList[number];

/**
 * Output projection for JSON/NDJSON: prefix the model record with `id` so the
 * model id is addressable under the same key (`.id`) as every other CLI
 * resource (`agents`, `multi-agent`, `history`). `value` is kept for backward
 * compatibility with existing scripts.
 */
export function cliModelRecord(
  model: ModelOptionData,
): { id: string } & ModelOptionData {
  return { id: model.value, ...model };
}

export function listableModelAccessEntries(
  models: ModelAccessList,
  options: { readonly includeUnavailable?: boolean } = {},
): ModelAccessList {
  if (options.includeUnavailable === true) return models;
  return models.filter(({ available }) => available);
}

export function formatNoListableModelsMessage(
  apiMode: CliContext['apiMode'],
  options: { readonly includeUnavailable?: boolean } = {},
): string {
  const accessHint =
    apiMode === 'personal'
      ? 'Retry with `--api-mode included` to try included relay access, run `texra login`, or configure a provider API key.'
      : apiMode === 'included'
        ? 'Run `texra login`, or retry with `--api-mode personal` after configuring a provider API key.'
        : 'Run `texra login` for included relay access, retry with `--api-mode included`, or configure a provider API key.';
  const statusHint =
    options.includeUnavailable === true
      ? 'No model records were returned for this installation.'
      : 'Run `texra models list --all` to see unavailable models and access status.';
  return ['No models are currently available.', statusHint, accessHint].join(
    '\n',
  );
}

async function loadModelAccessList(
  context: CliContext,
): Promise<ModelAccessList | { error: string }> {
  try {
    return await suppressCliFetchStackLogs(async () => {
      await initCliPlatform({ ...context, quietLogs: true });
      return getCliModelAccessList({ apiMode: context.apiMode });
    });
  } catch (error) {
    return { error: formatCliModelListError(error) };
  }
}

async function listModels(
  context: CliContext,
  options: { readonly includeUnavailable?: boolean } = {},
): Promise<number> {
  const result = await loadModelAccessList(context);
  if ('error' in result) {
    writeTextStderr(result.error);
    return CliExitCode.ModelOrNetworkError;
  }

  const listedModels = listableModelAccessEntries(result, options);
  if (context.outputFormat === 'text' && listedModels.length === 0) {
    writeTextStderr(formatNoListableModelsMessage(context.apiMode, options));
  }
  emitCliResult(
    context,
    {
      json: listedModels.map(({ model }) => cliModelRecord(model)),
      ndjson: listedModels.map(({ model }) => ({
        kind: 'model',
        model: cliModelRecord(model),
      })),
      text: listedModels
        .map(({ model, status }) => `${model.value}\t${model.label}\t${status}`)
        .join('\n'),
    },
    { paged: true },
  );
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
  if (model.provider) lines.push(`provider: ${model.provider}`);
  lines.push(`status: ${status}`);
  if (model.availabilityLabel)
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

  emitCliResult(context, {
    json: cliModelRecord(entry.model),
    ndjson: { kind: 'model', model: cliModelRecord(entry.model) },
    text: formatModelDetails(entry),
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
