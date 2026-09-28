/**
 * External tool availability: the process's `ToolAvailability` service.
 *
 * Runs every group's checks concurrently — one shared `probe` per group feeds
 * its `check` (availability), `statusLabel` (badge), and `detailCheck`
 * (human-readable detail) — and holds each workspace's last results in one
 * `SubscriptionRef`. What to check is each plugin's `availability` in
 * {@link @tools/plugins}.
 *
 * The composition root builds the service with the process runtime, so every
 * host probes the same way: each session forks a probe of its workspace when
 * it opens, the credential re-probe and the host triggers (an extension
 * installed, a folder opened, the Re-check button) refresh it, the tool
 * resolver reads the last results and the Tools dashboard follows them. No
 * UI has to be open for a run to be offered what its workspace can run.
 *
 * Results are keyed by workspace root: the probes read the workspace (the
 * GitHub group asks whether it is a git repository, Zotero reads its
 * configuration), so on a multi-project host one workspace's results must
 * not answer for another's.
 */

// Third-party imports
import {
  Cause,
  Duration,
  Effect,
  Layer,
  Result,
  SubscriptionRef,
} from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  storedDisabledTools,
  TOOL_PLUGINS,
  type ToolPlugin,
} from '@tools/plugins';
import type {
  ToolAvailabilityChecks,
  ToolProbeError,
  ToolProbeInputs,
  ToolProbeServices,
} from '@tools/toolProbes';
import {
  ToolAvailability,
  type AvailabilityResults,
  type ExternalToolCheckResult,
} from '@tools/toolAvailabilityService';
import { SharedAttempt } from '@utils/core/sharedAttempt';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'toolAvailability';

/**
 * Deadline on one group's probe and check. The probe runs detached from its
 * callers ({@link SharedAttempt}), so no caller's interrupt can end a stalled
 * child-process lookup or SDK import: without this bound one hung group would
 * hold the shared slot, and every caller joining it, indefinitely. A group
 * that misses it reports `unknown`, like any other probe failure.
 */
const GROUP_PROBE_TIMEOUT_MS = 20_000;

// ============================================================
// Switches
// ============================================================

/**
 * Switch a tool plugin on or off in the global state store the caller
 * holds. Every process sharing it follows the write (`AppState.changes`);
 * runs read the switch at their next step. A record that does not validate
 * refuses the change, so it is never written over and lost.
 */
export function setToolEnabled(
  toolId: string,
  enabled: boolean,
  store: StateStore,
) {
  return store
    .modify(GlobalStateKey.DISABLED_TOOLS, (stored) =>
      Result.map(storedDisabledTools(stored), (current) => {
        const disabled = new Set(current);
        if (enabled) disabled.delete(toolId);
        else disabled.add(toolId);
        return [...disabled];
      }),
    )
    .pipe(Effect.asVoid);
}

/**
 * Seed the disabled-tool list for first-time users only, on every host and
 * in the agent package.
 *
 * Every plugin flagged `toggleable: true` in TOOL_PLUGINS is treated as
 * opt-in and seeded as disabled on a fresh install, unless it is
 * `onByDefault`. Callers pass
 * the global state store they already hold. DISABLED_TOOLS is its own
 * fresh-install signal, because this seed is the only thing that writes it
 * before the user does: an absent value means neither the seed nor the user
 * has ever set the list, and a present one (an empty list included) means the
 * user's choices are already recorded, so re-seeding would silently disable
 * tools they had enabled.
 */
export const seedDisabledToolDefaults = Effect.fn('seedDisabledToolDefaults')(
  function* (state: StateStore) {
    const stored = yield* state.get<unknown>(GlobalStateKey.DISABLED_TOOLS);
    if ((yield* Effect.fromResult(storedDisabledTools(stored))) !== undefined)
      return;

    const defaults = TOOL_PLUGINS.filter(
      (plugin) => plugin.toggleable && !plugin.onByDefault,
    ).map((plugin) => plugin.id);
    yield* state.update(GlobalStateKey.DISABLED_TOOLS, defaults);
    yield* Effect.logInfo(
      `First install: default-disabled toggleable tools: ${defaults.join(', ')}`,
    ).pipe(withLogChannel(CHANNEL));
  },
);

// ============================================================
// The service
// ============================================================

/** A plugin with an external dependency to probe. */
type ProbedToolPlugin = ToolPlugin & {
  readonly availability: ToolAvailabilityChecks;
};

/** The plugins the availability layer probes, in manifest order. */
const PROBED_PLUGINS = TOOL_PLUGINS.filter(
  (plugin): plugin is ProbedToolPlugin => plugin.availability !== undefined,
);

/**
 * One workspace root's single-flight probe: callers join the probe in flight,
 * and one that arrives after it started reading its inputs schedules a
 * follow-up, so the results end on the latest state and a stale probe cannot
 * overwrite a fresh one by finishing last.
 */
interface ProbeLane {
  readonly attempt: SharedAttempt<readonly ExternalToolCheckResult[], never>;
  pendingRerun: boolean;
}

/**
 * The process's {@link ToolAvailability}, built once over the services the
 * probes read: every host's composition root installs it with the process
 * runtime.
 */
export const toolAvailabilityLayer: Layer.Layer<
  ToolAvailability,
  never,
  ToolProbeServices
> = Layer.effect(
  ToolAvailability,
  Effect.gen(function* () {
    const services = yield* Effect.context<ToolProbeServices>();
    const results = yield* SubscriptionRef.make<AvailabilityResults>(new Map());
    const lanes = new Map<string | undefined, ProbeLane>();
    // How many holders keep each root's results (see `hold`).
    const holders = new Map<string | undefined, number>();
    // Recurses instead of looping: a caller joining mid-probe can set
    // `pendingRerun` again before this settles.
    const probeUntilSettled = (
      lane: ProbeLane,
      inputs: ToolProbeInputs,
    ): Effect.Effect<readonly ExternalToolCheckResult[]> =>
      Effect.forEach(
        PROBED_PLUGINS,
        (plugin) => probeToolGroup(plugin, inputs),
        // Every group probes at once and no group's failure cancels a
        // sibling, because each one resolves to a result of its own.
        { concurrency: 'unbounded' },
      ).pipe(
        Effect.provideContext(services),
        // Only a held root's results are kept: one no session holds is
        // answered, not remembered.
        Effect.tap((probed) =>
          SubscriptionRef.update(results, (held) =>
            holders.has(inputs.workspace)
              ? new Map(held).set(inputs.workspace, probed)
              : held,
          ),
        ),
        Effect.flatMap((probed) => {
          if (!lane.pendingRerun) return Effect.succeed(probed);
          lane.pendingRerun = false;
          return probeUntilSettled(lane, inputs);
        }),
      );
    const refresh = (inputs: ToolProbeInputs) =>
      Effect.suspend(() => {
        const key = inputs.workspace;
        const lane = lanes.get(key) ?? {
          attempt: new SharedAttempt(),
          pendingRerun: false,
        };
        lanes.set(key, lane);
        // The latch resets in the segment that claims the slot, not on the
        // detached fiber: a caller joining before that fiber's first step
        // must not have its rerun wiped.
        lane.pendingRerun = lane.attempt.inFlight;
        // The lane leaves its map when its detached attempt settles, not when
        // its callers do: while the probe runs, a later caller joins it
        // rather than starting a second probe that could finish first.
        return lane.attempt.run(() =>
          probeUntilSettled(lane, inputs).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (lanes.get(key) === lane) lanes.delete(key);
              }),
            ),
          ),
        );
      });
    return {
      results,
      refresh,
      hold: (roots) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            holders.set(
              roots.workspace,
              (holders.get(roots.workspace) ?? 0) + 1,
            ),
          ),
          () =>
            Effect.suspend(() => {
              const left = (holders.get(roots.workspace) ?? 1) - 1;
              if (left > 0) {
                holders.set(roots.workspace, left);
                return Effect.void;
              }
              holders.delete(roots.workspace);
              return SubscriptionRef.update(results, (held) => {
                const next = new Map(held);
                next.delete(roots.workspace);
                return next;
              });
            }),
        ).pipe(
          Effect.andThen(Effect.forkScoped(refresh(roots))),
          Effect.asVoid,
        ),
    };
  }),
);

const probeToolGroup = Effect.fn('probeToolGroup')(function* (
  {
    id,
    toolNames,
    name,
    availability: { probe, check, statusLabel: getStatusLabel, detailCheck },
  }: ProbedToolPlugin,
  inputs: ToolProbeInputs,
): Effect.fn.Return<ExternalToolCheckResult, never, ToolProbeServices> {
  // Run check/status/detail from one shared probe result. Some groups
  // (Codex, Zotero, GitHub PR) touch async local state, so running the
  // callbacks independently can duplicate the same probe work.
  const probed = yield* Effect.gen(function* () {
    const probeResult = probe ? yield* probe(inputs) : undefined;
    const available = yield* check(probeResult);
    return { failure: undefined, probeResult, available };
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(GROUP_PROBE_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new Cause.TimeoutError(
            `timed out after ${GROUP_PROBE_TIMEOUT_MS / 1000}s`,
          ),
        ),
    }),
    Effect.catch((error) =>
      Effect.logWarning(`Availability probe failed for ${name}`).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.as({
          failure: { error },
          probeResult: undefined,
          available: false,
        }),
      ),
    ),
  );
  const detectedStatus = probed.available ? 'available' : 'not-found';
  const status: ExternalToolCheckResult['status'] = probed.failure
    ? 'unknown'
    : detectedStatus;
  const statusDetail = probed.failure
    ? `Availability check failed: ${toErrorMessage(probed.failure.error)}`
    : yield* resolveOptionalStatus(
        detailCheck,
        probed.probeResult,
        name,
        'status detail',
      );
  const statusLabel = probed.failure
    ? undefined
    : yield* resolveOptionalStatus(
        getStatusLabel,
        probed.probeResult,
        name,
        'status label',
      );
  return {
    id,
    tools: toolNames,
    name,
    status,
    statusLabel,
    statusDetail,
  };
});

function resolveOptionalStatus(
  getStatus:
    | ((
        probeResult?: unknown,
      ) => Effect.Effect<string | undefined, ToolProbeError, ToolProbeServices>)
    | undefined,
  probeResult: unknown,
  toolName: string,
  field: string,
): Effect.Effect<string | undefined, never, ToolProbeServices> {
  if (!getStatus) return Effect.succeed(undefined);
  return getStatus(probeResult).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Failed to resolve ${field} for ${toolName}`).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.as(undefined),
      ),
    ),
  );
}
