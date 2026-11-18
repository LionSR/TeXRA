import { defineCommand } from 'citty';
import { Effect } from 'effect';

import { MODELS } from '@texra-ai/llm';

import { getEnabledModels } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { enabledLabel } from '@ui/copy/format';

import {
  listCliEnabledModelCatalog,
  setCliModelEnabled,
} from '../runtime/models/enabledModels';
import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import { writeTextStderr } from '../runtime/platform/logSinks';
import { loadModelOptions } from '@texra/model/setupCredentialAccess';
import {
  cliModelRecord,
  cliModelStatus,
  formatCliModelDetails,
  formatNoListableModelsMessage,
  listableModelAccessEntries,
  loadCliModelAccessEntry,
  type CliModelListOptions,
} from '../runtime/models/modelAccess';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  cliResult,
  emitCliResult,
  emitPagedCliResult,
} from './_helpers/output';
import type { CliContext } from '../runtime/platform/cliContext';

/**
 * The report every model command gives when its runtime, platform or model
 * read fails: one stderr line and `ModelOrNetworkError`. Each command hands
 * it to `defineCliCommand` as its `catchExitCode`, which receives every
 * failure of the runtime build and of the program. Opening the platform
 * and reading the model options touch only local stores, so no failure here
 * is a network one.
 */
function reportModelPlatformFailure(cause: unknown): number {
  writeTextStderr(`texra: could not list models: ${toErrorMessage(cause)}`);
  return CliExitCode.ModelOrNetworkError;
}

const listModels = Effect.fn('listModels')(function* (
  context: CliContext,
  options: CliModelListOptions,
) {
  const services = yield* cliPlatform;
  const models = yield* loadModelOptions(
    services,
    options.includeUnavailable === true ? MODELS : undefined,
  );

  const listedModels = listableModelAccessEntries(models, options);
  if (context.outputFormat === 'text' && listedModels.length === 0) {
    writeTextStderr(formatNoListableModelsMessage(options));
  }
  const records = listedModels.map(cliModelRecord);
  yield* emitPagedCliResult(
    cliResult(
      'model',
      records,
      listedModels
        .map(
          (model) => `${model.value}\t${model.label}\t${cliModelStatus(model)}`,
        )
        .join('\n'),
    ),
  );
});

const showModel = Effect.fn('showModel')(function* (id: string) {
  const services = yield* cliPlatform;
  const entry = yield* loadCliModelAccessEntry(id, services);

  if (!entry) {
    writeTextStderr(`Model not found: ${id}`);
    return CliExitCode.Usage;
  }

  const record = cliModelRecord(entry);
  yield* emitCliResult(
    cliResult('model', record, formatCliModelDetails(entry)),
  );
});

const modelsListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List available models' },
  args: {
    all: {
      type: 'boolean',
      description: 'Include unavailable models with their access status',
    },
  },
  run: (context, ctx) =>
    listModels(context, { includeUnavailable: ctx.args.all === true }),
  catchExitCode: reportModelPlatformFailure,
});

const modelsShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show one model' },
  args: {
    id: {
      type: 'positional',
      required: true,
      description: 'Model id from `texra models list` (case-insensitive)',
    },
  },
  run: (_, ctx) => showModel(ctx.args.id),
  catchExitCode: reportModelPlatformFailure,
});

const listEnabledModels = Effect.fn('listEnabledModels')(function* () {
  const services = yield* cliPlatform;
  const catalog = yield* listCliEnabledModelCatalog(services);
  const enabled = yield* getEnabledModels(services);
  yield* emitPagedCliResult({
    json: { enabled, catalog },
    ndjson: [
      { kind: 'models-enabled' as const, models: enabled },
      ...catalog.map((model) => ({
        kind: 'model-catalog' as const,
        model,
      })),
    ],
    text: catalog
      .map(
        (model) =>
          `${enabledLabel(model.enabled)}\t${model.id}\t${model.label}\t${model.provider}`,
      )
      .join('\n'),
  });
});

const setModelEnabled = Effect.fn('setModelEnabled')(function* (
  id: string,
  enabled: boolean,
) {
  const services = yield* cliPlatform;
  return yield* setCliModelEnabled(services, id, enabled).pipe(
    Effect.flatMap((result) =>
      emitCliResult({
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
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        writeTextStderr(toErrorMessage(cause));
        return CliExitCode.Usage;
      }),
    ),
  );
});

const modelsEnabledCommand = defineCliCommand({
  meta: {
    name: 'enabled',
    description:
      'List models enabled for pickers (`/model`, lead model). Use enable/disable to change.',
  },
  run: listEnabledModels,
  catchExitCode: reportModelPlatformFailure,
});

const modelsEnableCommand = defineCliCommand({
  meta: {
    name: 'enable',
    description: 'Add a model to the picker',
  },
  args: {
    id: {
      type: 'positional',
      required: true,
      description: 'Model id, as `texra models list --all` shows it',
    },
  },
  run: (_, ctx) => setModelEnabled(ctx.args.id, true),
  catchExitCode: reportModelPlatformFailure,
});

const modelsDisableCommand = defineCliCommand({
  meta: {
    name: 'disable',
    description: 'Remove a model from the picker',
  },
  args: {
    id: {
      type: 'positional',
      required: true,
      description: 'Model id currently shown by `texra models enabled`',
    },
  },
  run: (_, ctx) => setModelEnabled(ctx.args.id, false),
  catchExitCode: reportModelPlatformFailure,
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
