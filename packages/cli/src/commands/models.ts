import { defineCommand } from 'citty';
import { Cause, Effect, Exit } from 'effect';

import { getEnabledModels } from '@model/computeModelOptions';
import type { ProcessServices } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { knownCliModelIds } from '../runtime/cliConfig';
import {
  listCliEnabledModelCatalog,
  setCliModelEnabled,
} from '../runtime/enabledModels';
import { installCliProcessRuntime } from '../runtime/cliProcessRuntime';
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

/**
 * The report every model command gives when its platform cannot come up: one
 * stderr line and `ModelOrNetworkError`.
 */
function reportModelPlatformFailure(cause: unknown): number {
  writeTextStderr(formatCliModelListError(cause));
  return CliExitCode.ModelOrNetworkError;
}

/**
 * Run one model-listing program on the process runtime this entry installs or
 * joins, as an `Exit`. A runtime that cannot be built arrives as a die rather
 * than as a rejection past the fold: building or joining it is the init's own
 * first step, so it belongs to the same "could not list models" report every
 * other init failure gets, exactly as it did while the init was a Promise
 * that did the install inside itself.
 */
function runModelCommandExit<A>(
  context: CliContext,
  program: Effect.Effect<A, unknown, ProcessServices>,
): Promise<Exit.Exit<A, unknown>> {
  return installCliProcessRuntime(context.storageRoot).then(
    (runtime) => runtime.runPromiseExit(program),
    (cause: unknown) => Exit.die(cause),
  );
}

async function listModels(
  context: CliContext,
  options: CliModelListOptions,
): Promise<number> {
  // The init and the access read are one program on the process runtime this
  // entry installs or joins; the whole of it stays inside the fetch-log
  // suppression window the access read needs.
  const outcome = await suppressCliFetchStackLogs(() =>
    runModelCommandExit(
      context,
      Effect.gen(function* () {
        const services = yield* initCliPlatform({
          ...context,
          quietLogs: true,
        });
        return yield* getCliModelAccessList({
          stores: services,
          models:
            options.includeUnavailable === true
              ? knownCliModelIds()
              : undefined,
        });
      }),
    ),
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
  // One program for the init and the entry lookup: the lookup loads the
  // access list itself, so `show` settles neither the init nor the list into
  // a Promise only to hand it straight back to a second run.
  const outcome = await suppressCliFetchStackLogs(() =>
    runModelCommandExit(
      context,
      Effect.gen(function* () {
        const services = yield* initCliPlatform({
          ...context,
          quietLogs: true,
        });
        return yield* loadCliModelAccessEntry(id, { stores: services });
      }),
    ),
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
 * services it wired, or report the failure as an exit code. Any cause counts,
 * defects and interruption included, exactly as the rejection this replaces
 * reached the caller.
 */
function initModelCommandPlatform(
  context: CliContext,
): Effect.Effect<CliPlatformServices | { readonly exitCode: number }> {
  return initCliPlatform({ ...context, quietLogs: true }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => ({
        exitCode: reportModelPlatformFailure(Cause.squash(cause)),
      })),
    ),
  );
}

function listEnabledModels(context: CliContext): Promise<number> {
  return installCliProcessRuntime(context.storageRoot).then(
    (runtime) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const services = yield* initModelCommandPlatform(context);
          if ('exitCode' in services) return services.exitCode;
          const catalog = listCliEnabledModelCatalog(services.globalState);
          const enabled = getEnabledModels(services.globalState);
          emitCliResult(
            context,
            {
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
                    `${model.enabled ? 'on' : 'off'}\t${model.id}\t${model.label}\t${model.provider}`,
                )
                .join('\n'),
            },
            { paged: true },
          );
          return CliExitCode.Success;
        }),
      ),
    reportModelPlatformFailure,
  );
}

function setModelEnabled(
  context: CliContext,
  id: string,
  enabled: boolean,
): Promise<number> {
  return installCliProcessRuntime(context.storageRoot).then(
    (runtime) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const services = yield* initModelCommandPlatform(context);
          if ('exitCode' in services) return services.exitCode;
          return yield* setCliModelEnabled(
            services.globalState,
            id,
            enabled,
          ).pipe(
            Effect.map((result) => {
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
            }),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                writeTextStderr(toErrorMessage(Cause.squash(cause)));
                return CliExitCode.Usage;
              }),
            ),
          );
        }),
      ),
    reportModelPlatformFailure,
  );
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
