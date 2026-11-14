import { defineCommand } from 'citty';
import { Cause, Effect, Exit } from 'effect';

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
import {
  cliModelRecord,
  formatCliModelDetails,
  getCliModelAccessList,
  formatNoListableModelsMessage,
  listableModelAccessEntries,
  loadCliModelAccessEntry,
  type CliModelAccess,
  type CliModelListOptions,
} from '../runtime/models/modelAccess';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult, emitPagedCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/platform/cliContext';

/**
 * The report every model command gives when its platform cannot come up: one
 * stderr line and `ModelOrNetworkError`. Each command hands it to
 * `defineCliCommand` as its `catchExitCode`, so a failure of the process
 * runtime build — which happens before any program below can handle it —
 * reads the same way an init failure inside one does. Opening the platform
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
  const outcome = yield* Effect.exit(
    Effect.gen(function* () {
      const services = yield* cliPlatform;
      return yield* getCliModelAccessList({
        stores: services,
        models: options.includeUnavailable === true ? MODELS : undefined,
      });
    }),
  );
  if (Exit.isFailure(outcome)) {
    return reportModelPlatformFailure(Cause.squash(outcome.cause));
  }
  const models: readonly CliModelAccess[] = outcome.value;

  const listedModels = listableModelAccessEntries(models, options);
  if (context.outputFormat === 'text' && listedModels.length === 0) {
    writeTextStderr(formatNoListableModelsMessage(options));
  }
  const records = listedModels.map(({ model }) => cliModelRecord(model));
  yield* emitPagedCliResult({
    json: records,
    ndjson: records.map((model) => ({ kind: 'model', model })),
    text: listedModels
      .map(({ model, status }) => `${model.value}\t${model.label}\t${status}`)
      .join('\n'),
  });
  return CliExitCode.Success;
});

const showModel = Effect.fn('showModel')(function* (id: string) {
  const outcome = yield* Effect.exit(
    Effect.gen(function* () {
      const services = yield* cliPlatform;
      return yield* loadCliModelAccessEntry(id, { stores: services });
    }),
  );
  if (Exit.isFailure(outcome)) {
    return reportModelPlatformFailure(Cause.squash(outcome.cause));
  }
  const entry: CliModelAccess | undefined = outcome.value;

  if (!entry) {
    writeTextStderr(`Model not found: ${id}`);
    return CliExitCode.Usage;
  }

  const record = cliModelRecord(entry.model);
  yield* emitCliResult({
    json: record,
    ndjson: { kind: 'model', model: record },
    text: formatCliModelDetails(entry),
  });
  return CliExitCode.Success;
});

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
  catchExitCode: reportModelPlatformFailure,
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
  run: (_, ctx) => showModel(ctx.args.id),
  catchExitCode: reportModelPlatformFailure,
});

/**
 * Shared by `enabled`/`enable`/`disable`: init the platform and hand back the
 * services it wired, or report the failure as an exit code. Any cause counts,
 * defects and interruption included, exactly as the rejection this replaces
 * reached the caller.
 */
const initModelCommandPlatform = cliPlatform.pipe(
  Effect.catchCause((cause) =>
    Effect.sync(() => ({
      exitCode: reportModelPlatformFailure(Cause.squash(cause)),
    })),
  ),
);

const listEnabledModels = Effect.fn('listEnabledModels')(function* () {
  const services = yield* initModelCommandPlatform;
  if ('exitCode' in services) return services.exitCode;
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
  return CliExitCode.Success;
});

const setModelEnabled = Effect.fn('setModelEnabled')(function* (
  id: string,
  enabled: boolean,
) {
  const services = yield* initModelCommandPlatform;
  if ('exitCode' in services) return services.exitCode;
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
      }).pipe(Effect.as(CliExitCode.Success)),
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
  args: { ...GLOBAL_ARGS },
  run: listEnabledModels,
  catchExitCode: reportModelPlatformFailure,
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
    ...GLOBAL_ARGS,
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
