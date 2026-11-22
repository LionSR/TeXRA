import { Effect } from 'effect';
import { Argument, Command } from 'effect/cli';

import { MODELS } from '@texra-ai/llm';

import { getEnabledModels, readModelOptions } from '@texra-ai/worldline/host';
import { toErrorMessage } from '@texra-ai/worldline/schemas';
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

import { boolFlag, cliCommand } from './_helpers/cliCommand';
import {
  cliResult,
  emitCliResult,
  emitPagedCliResult,
} from './_helpers/output';
import { failUsage, type CliContext } from '../runtime/platform/cliContext';

/**
 * The report every model command gives when its runtime, platform or model
 * read fails: one stderr line and `ModelOrNetworkError`. Each command hands
 * it to `cliCommand` as its `catchExitCode`, which receives every
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
    return yield* failUsage(`Model not found: ${id}`);
  }

  // A reference with `@effort` or `+mode` is valid when a run's bind takes
  // it: the model's verdict carries that decision, so ask it.
  const [verdict] = yield* readModelOptions(services, [entry.value]);
  const sent =
    verdict !== undefined && 'config' in verdict
      ? verdict.reasoning?.sent
      : undefined;
  if (sent !== undefined && 'refused' in sent) {
    return yield* failUsage(`Cannot use ${id}: ${sent.refused}`);
  }

  const record = cliModelRecord(entry);
  yield* emitCliResult(
    cliResult('model', record, formatCliModelDetails(entry)),
  );
});

const modelsListCommand = cliCommand('list', {
  description: 'List available models',
  config: {
    all: boolFlag('all', 'Include unavailable models with their access status'),
  },
  run: (context, input) =>
    listModels(context, { includeUnavailable: input.all }),
  catchExitCode: reportModelPlatformFailure,
});

const modelsShowCommand = cliCommand('show', {
  description: 'Show one model',
  config: {
    id: Argument.String('id').pipe(
      Argument.withDescription(
        'Model ID from `texra models list` (case-insensitive)',
      ),
    ),
  },
  run: (_, input) => showModel(input.id),
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
    Effect.catchCause((cause) => failUsage(toErrorMessage(cause))),
  );
});

const modelsEnabledCommand = cliCommand('enabled', {
  description: 'List models enabled in pickers (`/model`)',
  config: {},
  run: () => listEnabledModels(),
  catchExitCode: reportModelPlatformFailure,
});

const modelsEnableCommand = cliCommand('enable', {
  description: 'Add a model to the picker',
  config: {
    id: Argument.String('id').pipe(
      Argument.withDescription(
        'Model id, as `texra models list --all` shows it',
      ),
    ),
  },
  run: (_, input) => setModelEnabled(input.id, true),
  catchExitCode: reportModelPlatformFailure,
});

const modelsDisableCommand = cliCommand('disable', {
  description: 'Remove a model from the picker',
  config: {
    id: Argument.String('id').pipe(
      Argument.withDescription(
        'Model id currently shown by `texra models enabled`',
      ),
    ),
  },
  run: (_, input) => setModelEnabled(input.id, false),
  catchExitCode: reportModelPlatformFailure,
});

export const modelsCommand = Command.make('models').pipe(
  Command.withDescription('Inspect and manage TeXRA models'),
  Command.withSubcommands([
    modelsListCommand,
    modelsShowCommand,
    modelsEnabledCommand,
    modelsEnableCommand,
    modelsDisableCommand,
  ]),
);
