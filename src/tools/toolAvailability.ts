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
 * host probes the same way: each session holds its workspace, which probes it
 * when it opens; a committed write to a secret a plugin declares re-probes
 * every held workspace; the host triggers (an extension installed, a folder
 * opened, the Re-check button) refresh it; the tool resolver reads the last
 * results and the Tools dashboard follows them. No UI has to be open for a
 * run to be offered what its workspace can run.
 *
 * Results are keyed by workspace root: the probes read the workspace (the
 * GitHub group asks whether it is a git repository, Zotero reads its
 * configuration), so on a multi-project host one workspace's results must
 * not answer for another's.
 */

// Third-party imports
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Queue,
  Result,
  Scope,
  Semaphore,
  SubscriptionRef,
} from 'effect';

// Local imports
import { onAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';
import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  findToolPlugin,
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
import { forgetToolMisses } from '@utils/system/binaryResolver';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'toolAvailability';

/**
 * Deadline on one group's probe, check, status label and detail. A probe is
 * shared by every caller of its root, so no caller's interrupt ends a stalled
 * child-process lookup, SDK import or secret read: without this bound one
 * hung group would hold its root's probe, and every caller joining it, until
 * the process closed. A group that misses it reports `unknown`, like any
 * other probe failure.
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
 * tools they had enabled. A recorded id that names no plugin (a plugin
 * renamed or removed) is dropped from the record, with one warning.
 */
export const seedDisabledToolDefaults = Effect.fn('seedDisabledToolDefaults')(
  function* (state: StateStore) {
    const stored = yield* state.get(GlobalStateKey.DISABLED_TOOLS);
    const recorded = yield* Effect.fromResult(storedDisabledTools(stored));
    if (recorded !== undefined) {
      const unknown = [...recorded].filter((id) => !findToolPlugin(id));
      if (unknown.length === 0) return;
      yield* state.update(
        GlobalStateKey.DISABLED_TOOLS,
        [...recorded].filter((id) => findToolPlugin(id)),
      );
      return yield* Effect.logWarning(
        `Dropped switched-off tool plugins that no longer exist: ${unknown.join(', ')}`,
      ).pipe(withLogChannel(CHANNEL));
    }

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

/** Every secret key some plugin's availability answer reads. */
const REPROBE_SECRETS: ReadonlySet<string> = new Set(
  PROBED_PLUGINS.flatMap(
    (plugin) => plugin.availability.reprobeOnSecrets ?? [],
  ),
);

type ProbeResults = readonly ExternalToolCheckResult[];

/**
 * What the next round of a root's probe reads. A caller arriving while the
 * probe runs replaces the inputs and asks for another round, so the results
 * end on the latest state and a stale probe cannot overwrite a fresh one by
 * finishing last.
 */
interface ProbeRound {
  inputs: ToolProbeInputs;
  again: boolean;
}

/**
 * The process's {@link ToolAvailability}, built once over the services the
 * probes read: every host's composition root installs it with the process
 * runtime. The layer's scope owns every probe and the credential listener,
 * so closing the runtime interrupts and settles all of them.
 */
export const toolAvailabilityLayer: Layer.Layer<
  ToolAvailability,
  never,
  ToolProbeServices
> = Layer.effect(
  ToolAvailability,
  Effect.gen(function* () {
    const services = yield* Effect.context<ToolProbeServices>();
    const layerScope = yield* Scope.Scope;
    const results = yield* SubscriptionRef.make<AvailabilityResults>(new Map());
    // Each root's probe in flight: at most one per root.
    const lanes = new Map<
      string | undefined,
      { readonly round: ProbeRound; readonly fiber: Fiber.Fiber<ProbeResults> }
    >();
    // Each held root's holders' inputs, newest last: while any are left the
    // root's results are kept, and the newest is what a credential change
    // re-probes (a project reopened with new configuration supersedes the
    // inputs it was first opened with).
    const held = new Map<string | undefined, ToolProbeInputs[]>();
    // Claiming a lane with its fork, and a lane deciding between another
    // round and leaving the map, each run under this permit: no caller can
    // join a lane after its last round, or find the lane but no fiber.
    const claim = yield* Semaphore.make(1);

    const probeRound = (inputs: ToolProbeInputs) =>
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
          SubscriptionRef.update(results, (current) =>
            held.has(inputs.workspace)
              ? new Map(current).set(inputs.workspace, probed)
              : current,
          ),
        ),
      );
    const probeUntilSettled = (key: string | undefined, round: ProbeRound) =>
      Effect.gen(function* () {
        while (true) {
          const probed = yield* probeRound(round.inputs);
          const again = yield* claim.withPermit(
            Effect.sync(() => {
              if (round.again) {
                round.again = false;
                return true;
              }
              lanes.delete(key);
              return false;
            }),
          );
          if (!again) return probed;
        }
      }).pipe(
        // However the fiber ends (settled, interrupted, or a defect the
        // groups did not absorb), its lane leaves the map, so the next
        // caller starts a fresh probe instead of joining a dead fiber.
        Effect.ensuring(
          Effect.sync(() => {
            if (lanes.get(key)?.round === round) lanes.delete(key);
          }),
        ),
      );
    // Start probing `inputs`' root, or hand the probe in flight another
    // round with them. The fiber lives in the layer's scope, out of every
    // caller's reach, so a caller's interrupt abandons only its own wait.
    // Uninterruptible, so an interrupt cannot land between the fork and the
    // lane that records it.
    const start = (inputs: ToolProbeInputs) =>
      claim
        .withPermit(
          Effect.suspend(() => {
            const key = inputs.workspace;
            const running = lanes.get(key);
            if (running) {
              running.round.inputs = inputs;
              running.round.again = true;
              return Effect.succeed(running.fiber);
            }
            const round: ProbeRound = { inputs, again: false };
            return Effect.forkIn(
              probeUntilSettled(key, round),
              layerScope,
            ).pipe(
              Effect.tap((fiber) =>
                Effect.sync(() => lanes.set(key, { round, fiber })),
              ),
            );
          }),
        )
        .pipe(Effect.uninterruptible);
    // Every trigger (Re-check, a key saved, an extension or folder added)
    // may follow an install, so a tool it just installed must not be
    // answered from a remembered miss.
    const trigger = (inputs: ToolProbeInputs) =>
      Effect.andThen(Effect.sync(forgetToolMisses), start(inputs));

    // A committed write to a declared secret re-probes every held root with
    // its newest inputs. The bus delivers to a synchronous listener, so the
    // listener only enqueues the key; the loop below owns the refreshes.
    const changes = yield* Queue.unbounded<string>();
    const subscribed = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      onAppSignal(
        'credentialChanged',
        ({ key }) => {
          if (REPROBE_SECRETS.has(key)) Queue.offerUnsafe(changes, key);
        },
        subscribed,
      ),
    );
    yield* Deferred.await(subscribed);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(Queue.take(changes), () =>
          Effect.forEach(
            [...held.values()].flatMap((holders) => holders.slice(-1)),
            trigger,
            { discard: true },
          ),
        ),
      ),
    );

    return {
      results,
      refresh: (inputs) => Effect.flatMap(trigger(inputs), Fiber.join),
      // A session's own probe answers from the miss cache, so opening
      // sessions back to back does not repeat the lookups.
      hold: (roots) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const holders = held.get(roots.workspace) ?? [];
            holders.push(roots);
            held.set(roots.workspace, holders);
          }),
          () =>
            Effect.suspend(() => {
              const holders = held.get(roots.workspace) ?? [];
              holders.splice(holders.lastIndexOf(roots), 1);
              if (holders.length > 0) return Effect.void;
              held.delete(roots.workspace);
              return SubscriptionRef.update(results, (current) => {
                const next = new Map(current);
                next.delete(roots.workspace);
                return next;
              });
            }),
        ).pipe(Effect.andThen(start(roots)), Effect.asVoid),
    };
  }),
);

/**
 * Run one group's check, status label and detail from one shared probe
 * result. Some groups (Codex, Zotero, GitHub PR) touch async local state, so
 * running the callbacks independently can duplicate the same probe work.
 */
const checkToolGroup = Effect.fn('checkToolGroup')(function* (
  {
    id,
    toolNames,
    name,
    availability: { probe, check, statusLabel: getStatusLabel, detailCheck },
  }: ProbedToolPlugin,
  inputs: ToolProbeInputs,
): Effect.fn.Return<
  ExternalToolCheckResult,
  ToolProbeError,
  ToolProbeServices
> {
  const probeResult = probe ? yield* probe(inputs) : undefined;
  const available = yield* check(probeResult);
  const statusDetail = yield* resolveOptionalStatus(
    detailCheck,
    probeResult,
    name,
    'status detail',
  );
  const statusLabel = yield* resolveOptionalStatus(
    getStatusLabel,
    probeResult,
    name,
    'status label',
  );
  return {
    id,
    tools: toolNames,
    name,
    status: available ? 'available' : 'not-found',
    statusLabel,
    statusDetail,
  };
});

/**
 * {@link checkToolGroup} under the group deadline. A failure or a defect
 * (a callback that throws) is logged and reported as `unknown`; only an
 * interrupt ends the probe.
 */
const probeToolGroup = (
  plugin: ProbedToolPlugin,
  inputs: ToolProbeInputs,
): Effect.Effect<ExternalToolCheckResult, never, ToolProbeServices> => {
  const unknown = (error: unknown) =>
    Effect.logWarning(`Availability probe failed for ${plugin.name}`).pipe(
      Effect.annotateLogs({ data: error }),
      withLogChannel(CHANNEL),
      Effect.as({
        id: plugin.id,
        tools: plugin.toolNames,
        name: plugin.name,
        status: 'unknown' as const,
        statusLabel: undefined,
        statusDetail: `Availability check failed: ${toErrorMessage(error)}`,
      }),
    );
  return checkToolGroup(plugin, inputs).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(GROUP_PROBE_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new Cause.TimeoutError(
            `timed out after ${GROUP_PROBE_TIMEOUT_MS / 1000}s`,
          ),
        ),
    }),
    Effect.catch(unknown),
    Effect.catchDefect(unknown),
  );
};

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
