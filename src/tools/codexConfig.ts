import { Effect } from 'effect';
import { EFFORT_SCALE, ReasoningEffort } from 'llm-zoo';
import { z } from 'zod';

// Local imports - agent config
import { withLogChannel } from '@logger/effectLog';
import { codexBackendModelId } from '@model/providerCapabilities';
import type { StateReadFailed } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  isCodexModel,
  type AgentCliEffort,
  type ToolError,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { executeCommand } from '@utils/system/execUtils';
import {
  agentCliReasoning,
  resolveAgentCliModel,
  selectAgentCliModel,
  type AgentCliModelRule,
} from './agentCliModel';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

// Type-only imports
import type { ModelReasoningEffort } from '@openai/codex-sdk';

const CHANNEL = 'codexConfig';

/** Compile-time guard: every agent CLI effort is a level the Codex SDK takes. */
type _AssertTrue<T extends true> = T;
type _CodexEffortsAccepted = _AssertTrue<
  `${AgentCliEffort}` extends ModelReasoningEffort ? true : false
>;

export const CODEX_MODEL_RULE: AgentCliModelRule = {
  cli: 'Codex',
  eligible: isCodexModel,
  requirement: 'a non-retired OpenAI model served by the Codex backend',
};

// ============================================================================
// Model and effort
// ============================================================================

/** What one Codex thread runs: the backend slug and the effort to send. */
export interface CodexRun {
  /** The model's llm-zoo reference, the run's model label. */
  readonly ref: string;
  /** The Codex backend's model slug (`--model`). */
  readonly slug: string;
  readonly effort: AgentCliEffort | undefined;
  /** Why the effort differs from the one asked for, for the run's log. */
  readonly note: string | undefined;
}

const rank = (effort: ReasoningEffort) => EFFORT_SCALE.indexOf(effort);

/**
 * The route ceiling when the installed CLI's own levels are unknown: every
 * level up to `high`, which every Codex runtime accepts. Older runtimes
 * reject `xhigh` although the SDK type lists it.
 */
const UNPROBED_ROUTE_EFFORTS: readonly ReasoningEffort[] = EFFORT_SCALE.filter(
  (effort) => rank(effort) <= rank(ReasoningEffort.HIGH),
);

/**
 * Resolve the configured Codex model and effort through the reasoning
 * policy. A level above `high` is kept only when the installed CLI
 * (`binaryPath`) reports it for the model's slug, so other levels never wait
 * on a slow or hung Codex binary.
 */
export const codexRun = Effect.fn('codexConfig.codexRun')(function* (
  stores: SettingsStores,
  binaryPath: string | undefined,
): Effect.fn.Return<
  CodexRun,
  ToolError | StateReadFailed,
  ChildProcessSpawner
> {
  const modelString = yield* readSettingFrom<string>(
    stores,
    WorkspaceStateKey.CODEX_MODEL,
  );
  const userEffort = yield* readSettingFrom<AgentCliEffort>(
    stores,
    WorkspaceStateKey.CODEX_REASONING_EFFORT,
  );
  const selection = yield* resolveAgentCliModel(() =>
    selectAgentCliModel(modelString, CODEX_MODEL_RULE),
  );
  const slug = codexBackendModelId(selection.config);
  const uncapped = yield* resolveAgentCliModel(() =>
    agentCliReasoning(selection, undefined, { userEffort }),
  );
  const { effort } = uncapped.choice;
  const resolved =
    effort === null || rank(effort) <= rank(ReasoningEffort.HIGH)
      ? uncapped
      : yield* codexRouteEfforts(binaryPath, slug).pipe(
          Effect.flatMap((routeEfforts) =>
            resolveAgentCliModel(() =>
              agentCliReasoning(selection, undefined, {
                userEffort,
                routeEfforts,
              }),
            ),
          ),
        );
  return {
    ref: selection.config.ref,
    slug,
    effort: resolved.effort,
    note: resolved.choice.note,
  };
});

// ============================================================================
// Reasoning-level probe
//
// The installed Codex runtime reports the levels it serves for each model
// slug (`codex debug models --bundled`); those are the route's ceiling.
// ============================================================================

const codexRouteEffortsByKey = new Map<string, readonly ReasoningEffort[]>();
const codexRouteEffortLanes = new Map<string, PerKeyLane>();

type BundledCodexModel = {
  slug?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
};

/** Just the shape `catalogEfforts` depends on — a `models` array. Model
 *  entries stay `unknown` here and are duck-typed below, so one malformed
 *  entry elsewhere in the catalog can't take down a lookup for a model it
 *  doesn't concern. */
const BundledCodexCatalogSchema = z.object({
  models: z.array(z.unknown()),
});

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  EFFORT_SCALE.includes(value as ReasoningEffort);

/**
 * The levels the catalog lists for `slug`: `undefined` when the catalog is
 * unreadable, the unprobed ceiling when the slug is absent or lists none.
 */
const catalogEfforts = (
  stdout: string,
  slug: string,
): Effect.Effect<readonly ReasoningEffort[] | undefined> =>
  Effect.try({
    try: (): unknown => JSON.parse(stdout),
    catch: () => undefined,
  }).pipe(
    Effect.map((parsed) => {
      const catalog = BundledCodexCatalogSchema.safeParse(parsed);
      if (!catalog.success) return undefined;
      const entry = catalog.data.models.find(
        (item): item is BundledCodexModel =>
          typeof item === 'object' &&
          item != null &&
          (item as BundledCodexModel).slug === slug,
      );
      const efforts = (entry?.supported_reasoning_levels ?? [])
        .map((level) => level.effort)
        .filter(isReasoningEffort);
      return efforts.length > 0 ? efforts : UNPROBED_ROUTE_EFFORTS;
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  );

const probeRouteEfforts = Effect.fn('codexConfig.probeRouteEfforts')(function* (
  binaryPath: string,
  slug: string,
  key: string,
): Effect.fn.Return<readonly ReasoningEffort[], never, ChildProcessSpawner> {
  const cached = codexRouteEffortsByKey.get(key);
  if (cached != null) return cached;

  const result = yield* executeCommand(
    [binaryPath, 'debug', 'models', '--bundled'],
    // A capability probe of the binary itself: it runs no git command, and
    // this module holds no workspace whose identity it could carry.
    { quiet: true, timeout: 5_000, cwd: process.cwd(), settings: undefined },
  );
  if (result.timedOut || result.exitCode === 127) {
    yield* Effect.logWarning(
      'Codex reasoning-level probe failed; not caching the result',
    ).pipe(
      Effect.annotateLogs({
        data: {
          binaryPath,
          slug,
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      }),
      withLogChannel(CHANNEL),
    );
    return UNPROBED_ROUTE_EFFORTS;
  }
  if (!result.success) {
    codexRouteEffortsByKey.set(key, UNPROBED_ROUTE_EFFORTS);
    return UNPROBED_ROUTE_EFFORTS;
  }
  const efforts = yield* catalogEfforts(result.stdout, slug);
  if (efforts == null) {
    yield* Effect.logWarning(
      'Codex reasoning-level probe returned unreadable catalog',
    ).pipe(
      Effect.annotateLogs({ data: { binaryPath, slug } }),
      withLogChannel(CHANNEL),
    );
    return UNPROBED_ROUTE_EFFORTS;
  }
  codexRouteEffortsByKey.set(key, efforts);
  return efforts;
});

/**
 * The reasoning levels the resolved Codex runtime serves for `slug`, capped
 * at `high` when unknown. Timeouts and spawn failures are not cached so a
 * later call retries instead of permanently capping the level.
 *
 * One lane per binary and slug: concurrent launches queue behind the first
 * probe and read its cached answer instead of each spawning their own
 * five-second `codex debug models`.
 */
const codexRouteEfforts = Effect.fn('codexConfig.codexRouteEfforts')(function* (
  binaryPath: string | undefined,
  slug: string,
): Effect.fn.Return<readonly ReasoningEffort[], never, ChildProcessSpawner> {
  if (!binaryPath) return UNPROBED_ROUTE_EFFORTS;
  const key = `${binaryPath}\0${slug}`;
  return yield* probeRouteEfforts(binaryPath, slug, key).pipe(
    withPerKeyLane(codexRouteEffortLanes, key),
  );
});
