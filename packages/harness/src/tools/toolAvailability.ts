/**
 * External tool availability: the process's `ToolAvailability` service.
 *
 * Runs every group's check concurrently — each answers availability with
 * its badge and human-readable detail — and holds each workspace's last results in one
 * `SubscriptionRef`. What to check is each plugin's `availability`.
 *
 * The composition root builds the service with the process runtime, so every
 * host probes the same way: each session holds its workspace, which probes it
 * when it opens; a committed write to a secret a plugin declares re-probes
 * every held workspace; the host triggers (an extension installed, a folder
 * opened, the Re-check button) refresh it; the tool resolver reads the last
 * results and the Tools dashboard follows them. No UI has to be open for a
 * run to be offered what its workspace can run.
 *
 * Results are keyed by workspace root: the probes read the workspace (a
 * group may ask whether it is a git repository, or read the workspace's
 * configuration), so on a multi-project host one workspace's results must
 * not answer for another's. Each root probes on its own fiber, one round at
 * a time: a round asked for while one runs waits for it to finish, and a
 * burst of asks is answered by one round on the newest inputs.
 */

// Third-party imports
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Predicate,
  PubSub,
  RcMap,
  Result,
  Stream,
  SubscriptionRef,
} from 'effect';
import { HttpClient } from 'effect/http';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { subscribeAppSignal, type AppSignals } from '@platform/appSignals';
import { Secrets } from '@platform/secrets';
import type { StateStore } from '@shared/config/settings';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { storedDisabledTools, type Plugin } from '@tools/plugins';
import type {
  ToolAvailabilityChecks,
  ToolProbeInputs,
  ToolProbeServices,
} from '@tools/toolProbes';
import {
  ToolAvailability,
  type AvailabilityResults,
  type ExternalToolCheckResult,
} from '@tools/toolAvailabilityService';
import { ToolCatalog } from '@tools/liveTools';
import { ToolRegistry } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'toolAvailability';

/**
 * Deadline on one group's complete check, including its label and detail. A
 * root's rounds run on its own fiber, so no caller's interrupt ends a stalled
 * child-process lookup, SDK import or secret read: without this bound one
 * hung group would hold every later round of its root, and every caller
 * waiting on one, until the root's last holder closed. A group that misses it
 * reports `unknown`, like any other probe failure.
 */
const GROUP_PROBE_TIMEOUT_MS = 20_000;

// ============================================================
// Switches
// ============================================================

/**
 * Seed the disabled-tool list for first-time users only, on every host and
 * in the agent package: every plugin of `plugins` whose switch starts `off`.
 * DISABLED_TOOLS is its own fresh-install signal: only this seed writes it
 * before the user does, so an absent value means the list was never set, and
 * a present one (an empty list included) holds the user's choices, which a
 * re-seed would silently undo. The read and the seed are one `modify`, so a
 * switch another process records between them is kept. A recorded id that
 * names no plugin of `plugins` is kept: one composition's list is not every
 * list that shares the store, and an id no plugin has switches nothing.
 */
export const seedDisabledToolDefaults = Effect.fn('seedDisabledToolDefaults')(
  function* (state: StateStore, plugins: readonly Plugin[]) {
    const defaults = plugins
      .filter((plugin) => plugin.toggle === 'off')
      .map((plugin) => plugin.id);
    let seeded = false;
    yield* state.modify(GlobalStateKey.DISABLED_TOOLS, (stored) =>
      Result.map(storedDisabledTools(stored), (recorded) => {
        seeded = recorded === undefined;
        return seeded ? defaults : stored;
      }),
    );
    if (!seeded) return;
    // Debug: the seed runs while a host's runtime builds, before the CLI's
    // platform silences its stderr diagnostics.
    yield* Effect.logDebug(
      `First install: plugins switched off by default: ${defaults.join(', ')}`,
    ).pipe(withLogChannel(CHANNEL));
  },
);

// ============================================================
// The service
// ============================================================

/** A plugin with an external dependency to probe. */
type ProbedToolPlugin = Plugin & {
  readonly availability: ToolAvailabilityChecks;
};

type ProbeResults = readonly ExternalToolCheckResult[];

/** What a root's next round reads, numbered so that whoever asked for it can
 *  tell which answer covers its ask. */
interface ProbeRequest {
  readonly round: number;
  readonly inputs: ToolProbeInputs;
}

/** Ask a root for a round over `inputs`, after the one in flight. Returns the
 *  round's number. */
const request = (
  requests: SubscriptionRef.SubscriptionRef<ProbeRequest | undefined>,
  inputs: ToolProbeInputs,
) =>
  SubscriptionRef.modify(requests, (last) => {
    const round = (last?.round ?? 0) + 1;
    return [round, { round, inputs }];
  });

/**
 * The process's {@link ToolAvailability}, built once over the services the
 * probes read: every host's composition root installs it with the process
 * runtime. The layer's scope owns every root's probe, so closing the runtime
 * interrupts all of them.
 */
export const toolAvailabilityLayer: Layer.Layer<
  ToolAvailability,
  never,
  ToolProbeServices | ToolRegistry | ToolCatalog | AppSignals
> = Layer.effect(
  ToolAvailability,
  Effect.gen(function* () {
    const catalog = yield* ToolCatalog;
    // The plugins the layer probes, in list order, and every secret key
    // some plugin's availability answer reads.
    const PROBED_PLUGINS = [...(yield* ToolRegistry).entries.values()].filter(
      (plugin): plugin is ProbedToolPlugin => plugin.availability !== undefined,
    );
    const REPROBE_SECRETS: ReadonlySet<string> = new Set(
      PROBED_PLUGINS.flatMap(
        (plugin) => plugin.availability.reprobeOnSecrets ?? [],
      ),
    );
    // What a round runs on, beside a plugin's own services: exactly the
    // probe services, never the build's scope or references with them.
    const services = Context.pick(
      Secrets,
      FileSystem.FileSystem,
      HttpClient.HttpClient,
      ChildProcessSpawner,
    )(yield* Effect.context<ToolProbeServices>());
    const results = yield* SubscriptionRef.make<AvailabilityResults>(new Map());

    const probeRound = (inputs: ToolProbeInputs) =>
      Effect.forEach(
        PROBED_PLUGINS,
        // A plugin's probe runs with its own process services while its
        // layer is up (a language server roster, say); a probe never
        // brings a layer up, which could act (one may register tools).
        (plugin) =>
          Effect.scoped(
            Effect.flatMap(catalog.processServices(plugin.id), (own) =>
              Option.isSome(own)
                ? Effect.provide(probeToolGroup(plugin, inputs), own.value)
                : probeToolGroup(plugin, inputs),
            ),
          ),
        // Every group probes at once and no group's failure cancels a
        // sibling, because each one resolves to a result of its own.
        { concurrency: 'unbounded' },
      ).pipe(Effect.provideContext(services));

    // Each root's probe, held by every session open on it and by each
    // refresh while it waits. The last holder's release ends the root's
    // round in flight and drops its results, so the published map holds only
    // the roots something holds.
    const probes = yield* RcMap.make({
      lookup: (workspace: string | undefined) =>
        Effect.gen(function* () {
          const requests = yield* SubscriptionRef.make<
            ProbeRequest | undefined
          >(undefined);
          const answers = yield* Effect.acquireRelease(
            PubSub.unbounded<{
              readonly round: number;
              readonly probed: Exit.Exit<ProbeResults>;
            }>({ replay: 1 }),
            PubSub.shutdown,
          );
          // Subscribed before the root's first round reads a secret, so no
          // write committed after that read goes unanswered.
          const secretWrites = yield* subscribeAppSignal('credentialChanged');
          yield* Effect.addFinalizer(() =>
            SubscriptionRef.update(results, (current) => {
              const next = new Map(current);
              next.delete(workspace);
              return next;
            }),
          );
          // The round in flight finishes; the newest request waits for it,
          // replacing any older one still waiting.
          yield* SubscriptionRef.changes(requests).pipe(
            Stream.filter(Predicate.isNotUndefined),
            Stream.buffer({ capacity: 1, strategy: 'sliding' }),
            Stream.runForEach(({ round, inputs }) =>
              probeRound(inputs).pipe(
                Effect.tap((probed) =>
                  SubscriptionRef.update(results, (current) =>
                    new Map(current).set(workspace, probed),
                  ),
                ),
                // A round that fails (a plugin layer's start failing under
                // it) gives its waiters that failure, and the root's next
                // request still runs.
                Effect.exit,
                Effect.flatMap((probed) =>
                  PubSub.publish(answers, { round, probed }),
                ),
              ),
            ),
            Effect.forkScoped,
          );
          // A committed write to a declared secret asks again with the
          // root's newest inputs.
          yield* secretWrites.pipe(
            Stream.filter(({ key }) => REPROBE_SECRETS.has(key)),
            Stream.runForEach(() =>
              SubscriptionRef.update(
                requests,
                (last) =>
                  last && { round: last.round + 1, inputs: last.inputs },
              ),
            ),
            Effect.forkScoped,
          );
          return { requests, answers };
        }),
    });

    return {
      results,
      refresh: (inputs) =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* RcMap.get(probes, inputs.workspace);
            const round = yield* request(root.requests, inputs);
            const answer = yield* Stream.fromPubSub(root.answers).pipe(
              Stream.filter((answered) => answered.round >= round),
              Stream.runHead,
            );
            // The answers end only when the layer closes, which ends this
            // wait as it ends every probe.
            return yield* Option.match(answer, {
              onNone: () => Effect.interrupt,
              onSome: ({ probed }) => probed,
            });
          }),
        ),
      hold: (roots) =>
        Effect.flatMap(RcMap.get(probes, roots.workspace), (root) =>
          Effect.asVoid(request(root.requests, roots)),
        ),
    };
  }),
);

/**
 * One plugin's check under the group deadline. A failure or a defect
 * (a check that throws) is logged and reported as `unknown`; only an
 * interrupt ends the probe.
 */
const probeToolGroup = (
  plugin: ProbedToolPlugin,
  inputs: ToolProbeInputs,
): Effect.Effect<ExternalToolCheckResult, never, ToolProbeServices> => {
  const unknown = (error: unknown) =>
    Effect.logWarning(`Availability probe failed for plugin ${plugin.id}`).pipe(
      Effect.annotateLogs({ data: error }),
      withLogChannel(CHANNEL),
      Effect.as({
        id: plugin.id,
        tools: (plugin.tools ?? []).map((tool) => tool.definition.name),
        status: 'unknown' as const,
        statusLabel: undefined,
        statusDetail: `Availability check failed: ${toErrorMessage(error)}`,
      }),
    );
  return Effect.suspend(() => plugin.availability.check(inputs)).pipe(
    Effect.map(({ available, statusLabel, statusDetail }) => ({
      id: plugin.id,
      tools: (plugin.tools ?? []).map((tool) => tool.definition.name),
      status: available ? ('available' as const) : ('not-found' as const),
      statusLabel,
      statusDetail,
    })),
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
