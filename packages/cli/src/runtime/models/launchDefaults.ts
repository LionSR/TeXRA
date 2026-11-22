import { Effect } from 'effect';

import {
  decideRunModel,
  type RunModelCandidate,
  type RunModelDecisionReason,
} from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';

import { CLI_CHEAP_START_MODEL } from '@texra/model/curatedModels';
import { pickDefaultToolUseAgent } from '@texra/shared/constants/agents';
import {
  cliCommandDefaults,
  resolveKnownCliModelId,
  usableDefaultAgent,
} from '../platform/cliConfig';
import {
  CliUsageError,
  isQuiet,
  type CliContext,
} from '../platform/cliContext';
import { writeTextStderr } from '../platform/logSinks';
import { selectCliRunnableModel } from './modelAccess';
import type { SettingsStores } from '@texra-ai/harness/plugins';

/** Trim `-m`; throw a Usage error for unknown ids; undefined when absent. */
export function assertExplicitModelKnown(
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const resolved = resolveKnownCliModelId(trimmed);
  if (!resolved) {
    throw new CliUsageError({
      message: `Model not found: ${trimmed}. Use \`texra models list\` to see available models.`,
    });
  }
  return resolved;
}

/**
 * The one four-tier model lookup every `texra` command starts from:
 * `--model` → `TEXRA_MODEL` → the command's `texra.<role>` section over the
 * top-level row → the cheap-start model. `explicit` is already checked
 * (`assertExplicitModelKnown`) or comes from a stored run.
 */
function cliModelCandidates(
  stores: SettingsStores,
  role: 'chat' | 'run',
  explicit: string | undefined,
  envModel: string | undefined,
): RunModelCandidate[] {
  return [
    { model: explicit, reason: 'explicit-override' },
    { model: envModel, reason: 'environment' },
    { model: cliCommandDefaults(stores, role).model, reason: 'command-config' },
    { model: CLI_CHEAP_START_MODEL, reason: 'builtin-default' },
  ];
}

/**
 * The model a headless command (`texra run`, `texra tasks start`) runs on,
 * from the four tiers over what this machine can run. `stores` is the three
 * setting slots availability and the command's configured default are read
 * from, handed over by the command's own `CliPlatform` services.
 */
export const selectCliRunModel = Effect.fn('selectCliRunModel')(function* (
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
  stores: SettingsStores,
) {
  // One failure channel for the whole resolution: an unknown `--model` and
  // an unavailable choice both reach the caller as the `CliUsageError` the
  // command surfaces.
  const usageError = (error: unknown) =>
    new CliUsageError({ message: toErrorMessage(error) });
  const resolution = yield* Effect.try({
    try: () =>
      cliModelCandidates(
        stores,
        role,
        assertExplicitModelKnown(modelOverride),
        context.envModel,
      ),
    catch: usageError,
  }).pipe(
    Effect.flatMap((candidates) =>
      selectCliRunnableModel(candidates, { stores }).pipe(
        Effect.mapError(usageError),
      ),
    ),
  );
  if (resolution.notice && !isQuiet(context)) {
    writeTextStderr(resolution.notice);
  }
  return resolution.model;
});

interface ChatDefaults {
  readonly agent: string;
  readonly model: string;
  readonly modelSource: RunModelDecisionReason;
}

interface ResolveChatDefaultsInit {
  /** The setting slots the `texra.chat` section is read from. */
  readonly stores: SettingsStores;
  readonly agentOverride?: string;
  /** `--model` (checked by the chat command) or the resumed run's model. */
  readonly modelOverride?: string;
  readonly envAgent?: string;
  readonly envModel?: string;
  readonly visibleToolUseAgents?: readonly { readonly name: string }[];
}

/**
 * The chat's agent and model before availability is known: the same tiers
 * as a headless command (`--agent`/`--model` → environment → `texra.chat` →
 * the built-in agent pick and the cheap-start model). The chat opens without
 * a credential, so whether the model can run is checked by its caller.
 */
export function resolveChatDefaults(
  init: ResolveChatDefaultsInit,
): ChatDefaults {
  const agent =
    init.agentOverride?.trim() ||
    usableDefaultAgent(init.envAgent) ||
    cliCommandDefaults(init.stores, 'chat').agent;
  const modelDecision = decideRunModel(
    cliModelCandidates(init.stores, 'chat', init.modelOverride, init.envModel),
  );
  // The built-in default is always a candidate and every candidate is
  // runnable here, so the decision always names one.
  if (modelDecision === null)
    throw new Error('The chat model decision named no model');
  return {
    agent: agent ?? pickDefaultToolUseAgent(init.visibleToolUseAgents),
    model: modelDecision.model,
    modelSource: modelDecision.reason,
  };
}
