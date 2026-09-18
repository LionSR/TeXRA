import { Effect } from 'effect';

import type { RunModelCandidate } from '@model/runModelDecision';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import {
  CLI_CHEAP_START_MODEL,
  cliCommandDefaults,
  resolveKnownCliModelId,
} from './cliConfig';
import { CliUsageError, type CliContext } from './cliContext';
import { writeTextStderr } from './logSinks';
import { selectCliRunnableModel, type CliModelStores } from './modelAccess';
import { shouldRenderRunProgress } from './runProgressRenderer';

/** Trim `-m`; throw a Usage error for unknown ids; undefined when absent. */
export function assertExplicitModelKnown(
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const resolved = resolveKnownCliModelId(trimmed);
  if (!resolved) {
    throw new CliUsageError(
      `Model not found: ${trimmed}. Use \`texra models list\` to see available models.`,
    );
  }
  return resolved;
}

function cliRunModelCandidates(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): RunModelCandidate[] {
  const explicit = assertExplicitModelKnown(modelOverride);
  return [
    { model: explicit, reason: 'explicit-override' },
    { model: context.envModel, reason: 'environment' },
    { model: cliCommandDefaults(role).model, reason: 'command-config' },
    { model: CLI_CHEAP_START_MODEL, reason: 'builtin-default' },
  ];
}

/**
 * `stores` is the secret store and global state availability is computed from,
 * handed over by the command's own `initCliPlatform` result rather than looked
 * up again here.
 */
export const selectCliRunModel = Effect.fn('selectCliRunModel')(function* (
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
  stores: CliModelStores,
) {
  // One failure plane for the whole resolution: the candidate list's own
  // usage error and the selection's unavailable-model error both reach the
  // caller as the `CliUsageError` the command surfaces, exactly as the
  // former try/catch around the await did.
  const resolution = yield* Effect.try({
    try: () => cliRunModelCandidates(context, modelOverride, role),
    catch: ensureError,
  }).pipe(
    Effect.flatMap((candidates) =>
      selectCliRunnableModel(candidates, { stores }),
    ),
    Effect.catch((error) =>
      Effect.fail(new CliUsageError(toErrorMessage(error))),
    ),
  );
  if (resolution.notice && context.quietLogs !== true) {
    writeTextStderr(resolution.notice);
  }
  return resolution.model;
});

/** Derive the headless run context shared by every CLI runner. */
export function buildHeadlessRunContext(context: CliContext): CliContext {
  return {
    ...context,
    quietLogs: true,
    renderRunProgress: shouldRenderRunProgress(context),
  };
}
