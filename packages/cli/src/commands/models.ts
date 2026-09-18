import { defineCommand } from 'citty';

import { getEnabledModels } from '@model/computeModelOptions';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { knownCliModelIds } from '../runtime/cliConfig';
import {
  listCliEnabledModelCatalog,
  setCliModelEnabled,
} from '../runtime/enabledModels';
import { CliExitCode } from '../runtime/exitCodes';
import {
  initCliPlatform,
  type CliPlatformServices,
} from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  cliModelRecord,
  formatCliModelDetails,
  getCliModelAccessList,
  formatNoListableModelsMessage,
  listableModelAccessEntries,
  loadCliModelAccessEntry,
  type CliModelAccess,
  type CliModelListOptions,
} from '../runtime/modelAccess';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  formatCliModelListError,
  suppressCliFetchStackLogs,
} from './_helpers/fetchSilencer';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

async function listModels(
  context: CliContext,
  options: CliModelListOptions,
): Promise<number> {
  let models: readonly CliModelAccess[];
  try {
    models = await suppressCliFetchStackLogs(async () => {
      const services = await initCliPlatform({ ...context, quietLogs: true });
      return services.runtime.runPromise(
        getCliModelAccessList({
          stores: services,
          models:
            options.includeUnavailable === true
              ? knownCliModelIds()
              : undefined,
        }),
      );
    });
  } catch (error) {
    writeTextStderr(formatCliModelListError(error));
    return CliExitCode.ModelOrNetworkError;
  }

  const listedModels = listableModelAccessEntries(models, options);
  if (context.outputFormat === 'text' && listedModels.length === 0) {
    writeTextStderr(formatNoListableModelsMessage(options));
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
  let entry: CliModelAccess | undefined;
  try {
    // One program on the stores the init just wired: the entry lookup loads
    // the access list itself, so `show` no longer settles a list into a
    // Promise only to hand it straight back to a second run.
    entry = await suppressCliFetchStackLogs(async () => {
      const services = await initCliPlatform({ ...context, quietLogs: true });
      return services.runtime.runPromise(
        loadCliModelAccessEntry(id, { stores: services }),
      );
    });
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
    text: formatCliModelDetails(entry),
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

/**
 * Shared by `enabled`/`enable`/`disable`: init the platform and hand back the
 * services it wired, or report the error as an exit code.
 */
async function initCliPlatformOrReport(
  context: CliContext,
): Promise<CliPlatformServices | { readonly exitCode: number }> {
  try {
    return await initCliPlatform({ ...context, quietLogs: true });
  } catch (error) {
    writeTextStderr(formatCliModelListError(error));
    return { exitCode: CliExitCode.ModelOrNetworkError };
  }
}

async function listEnabledModels(context: CliContext): Promise<number> {
  const services = await initCliPlatformOrReport(context);
  if ('exitCode' in services) return services.exitCode;
  const catalog = listCliEnabledModelCatalog(services.globalState);
  const enabled = getEnabledModels(services.globalState);
  emitCliResult(
    context,
    {
      json: { enabled, catalog },
      ndjson: [
        { kind: 'models-enabled' as const, models: enabled },
        ...catalog.map((model) => ({ kind: 'model-catalog' as const, model })),
      ],
      text: catalog
        .map(
          (model) =>
            `${model.enabled ? 'on' : 'off'}\t${model.id}\t${model.label}\t${model.provider}`,
        )
        .join('\n'),
    },
    { paged: true },
  );
  return CliExitCode.Success;
}

async function setModelEnabled(
  context: CliContext,
  id: string,
  enabled: boolean,
): Promise<number> {
  const services = await initCliPlatformOrReport(context);
  if ('exitCode' in services) return services.exitCode;
  try {
    const result = await services.runtime.runPromise(
      setCliModelEnabled(services.globalState, id, enabled),
    );
    emitCliResult(context, {
      json: result,
      ndjson: {
        kind: 'model-enabled',
        model: {
          id: result.model,
          enabled: result.enabled,
          list: result.list,
        },
      },
      text: result.enabled
        ? `Enabled ${result.model} in the model picker.`
        : `Disabled ${result.model} in the model picker.`,
    });
    return CliExitCode.Success;
  } catch (error) {
    writeTextStderr(toErrorMessage(error));
    return CliExitCode.Usage;
  }
}

const modelsEnabledCommand = defineCliCommand({
  meta: {
    name: 'enabled',
    description:
      'List models enabled for pickers (`/model`, lead model). Use enable/disable to change.',
  },
  args: { ...GLOBAL_ARGS },
  run: listEnabledModels,
});

const modelsEnableCommand = defineCliCommand({
  meta: {
    name: 'enable',
    description: 'Add a model to the picker',
  },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Model id (e.g. grok45, deepseekproT)',
    },
  },
  run: (context, ctx) => setModelEnabled(context, ctx.args.id, true),
});

const modelsDisableCommand = defineCliCommand({
  meta: {
    name: 'disable',
    description: 'Remove a model from the picker',
  },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Model id currently shown by `texra models enabled`',
    },
  },
  run: (context, ctx) => setModelEnabled(context, ctx.args.id, false),
});

export const modelsCommand = defineCommand({
  meta: {
    name: 'models',
    description: 'Inspect and manage TeXRA models',
  },
  subCommands: {
    list: modelsListCommand,
    show: modelsShowCommand,
    enabled: modelsEnabledCommand,
    enable: modelsEnableCommand,
    disable: modelsDisableCommand,
  },
});
