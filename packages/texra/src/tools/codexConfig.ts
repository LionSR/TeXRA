import { Effect, Option, Predicate, Schema } from 'effect';
import { EFFORT_SCALE, ReasoningEffort } from 'llm-zoo';

// Local imports - agent config
import { codexBackendModelId } from '@texra-ai/llm';
import {
  withLogChannel,
  withPerKeyLane,
  type PerKeyLane,
  Settings,
} from '@texra-ai/harness/host';
import { executeCommand } from '@texra-ai/harness/node';
import {
  isCodexModel,
  type AgentCliEffort,
} from '@texra/shared/agentCliSettings';
import { CodexStateKey } from '@texra/shared/settingsView/integrationSettings';
import {
  agentCliReasoning,
  resolveAgentCliModel,
  selectAgentCliModel,
  type AgentCliModelRule,
} from './agentCliModel';
import type { ToolError } from '@texra-ai/harness/plugins';
import type { StateReadFailed, SettingsStores } from '@texra-ai/harness/host';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

// Type-only imports
import type { ModelReasoningEffort } from '@openai/codex-sdk';

const CHANNEL = 'codexConfig';

/** Compile-time guard: every agent CLI effort is a level the Codex SDK takes. */
type _AssertTrue<T extends true> = T;
type _CodexEffortsAccepted = _AssertTrue<
  `${AgentCliEffort}` extends ModelReasoningEffort ? true : false
>;

const CODEX_MODEL_RULE: AgentCliModelRule = {
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
  const modelString = yield* Settings.get<string>(stores, CodexStateKey.MODEL);
  const userEffort = yield* Settings.get<AgentCliEffort>(
    stores,
    CodexStateKey.REASONING_EFFORT,
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

/** Just the shape `catalogEfforts` depends on — a `models` array. Model
 *  entries stay `unknown` here and only the one for the asked slug is
 *  decoded, so one malformed entry elsewhere in the catalog can't take down
 *  a lookup for a model it doesn't concern. */
const BundledCodexCatalogSchema = Schema.fromJsonString(
  Schema.Struct({ models: Schema.Array(Schema.Unknown) }),
);

/** One catalog entry. The levels stay `unknown` and a null list is allowed,
 *  so a level with no recognised `effort` is filtered out rather than failing
 *  the whole entry; only a list that is not an array makes it unreadable. */
const BundledCodexModelSchema = Schema.Struct({
  slug: Schema.String,
  supported_reasoning_levels: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Unknown)),
  ),
});

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  EFFORT_SCALE.includes(value as ReasoningEffort);

/**
 * The levels the catalog lists for `slug`: `undefined` when the catalog or
 * the slug's entry is unreadable, the unprobed ceiling when the slug is
 * absent or lists none.
 */
function catalogEfforts(
  stdout: string,
  slug: string,
): readonly ReasoningEffort[] | undefined {
  const catalog = Schema.decodeUnknownOption(BundledCodexCatalogSchema)(stdout);
  if (Option.isNone(catalog)) return undefined;
  const raw = catalog.value.models.find(
    (item) => Predicate.hasProperty(item, 'slug') && item.slug === slug,
  );
  if (raw === undefined) return UNPROBED_ROUTE_EFFORTS;
  const entry = Schema.decodeUnknownOption(BundledCodexModelSchema)(raw);
  if (Option.isNone(entry)) return undefined;
  const efforts = (entry.value.supported_reasoning_levels ?? [])
    .map((level) =>
      Predicate.hasProperty(level, 'effort') ? level.effort : undefined,
    )
    .filter(isReasoningEffort);
  return efforts.length > 0 ? efforts : UNPROBED_ROUTE_EFFORTS;
}

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
  const efforts = catalogEfforts(result.stdout, slug);
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
