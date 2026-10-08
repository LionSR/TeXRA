/**
 * A plugin: what one unit of the harness contributes (its tools, the probe
 * of its dependency, its switch, its continuation, prompt section and
 * layers). The harness's built-ins are `@tools/builtinPlugins`; an app
 * passes its list, built-ins included, to `processLayer`, and the
 * process's `ToolRegistry` holds it (`@tools/toolTable`), which every
 * reader takes it from: availability probes, the first-install switch seed,
 * the switches, a run's injected tools
 * (`@agent/runtime/agentToolResolution`), and the bundled skills and agents
 * at `resources/plugins/<id>/`, which a switched-off plugin withholds with
 * its tools. How the app shows a plugin is its own record, keyed by id.
 *
 * Rules: an id is persisted (the disabled-tools key, and the plugin a run's
 * offered tool records), so it never changes and is never reused; every
 * tool belongs to exactly one plugin (checked when the table is built). No
 * hooks, task kinds or second event channels: a plugin holds state only in
 * its process or session layer and writes rows only of its own kinds
 * (`arms`), through the one publisher.
 */

// Third-party imports
import { Effect, type Layer, Result, Stream } from 'effect';
import { z } from 'zod';

// Local imports
import type { Runs } from '@agent/runtime/runRegistry';
import type { RuntimeTool, ToolServices } from '@agent/runtime/ToolServices';
import { emitAppSignal } from '@eventBus/AppSignals';
import { StateReadFailed, type StateStore } from '@platform/interfaces';
import type {
  CommitOrdinal,
  JsonValue,
  RunId,
  SessionEvent,
  ToolFact,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { ToolAvailabilityChecks } from '@tools/toolProbes';
import type {
  Continuation,
  PluginHold,
  ProcessPluginLayer,
  PromptSection,
  RequestDecisionHook,
  SessionPluginLayer,
} from '@tools/toolTable';

/** What a transition rule reads of a plugin row: its value and its parent
 *  edge. */
interface PluginRow {
  readonly value: JsonValue;
  readonly parent: RunId | null;
}

/**
 * One row kind a plugin owns (`plugin.fact`): the version it writes, the
 * schema of that version's value, and the adjacent upcasters (`upcasters[i]`
 * maps version `i + 1` to `i + 2`) the store reads an older value through.
 * The store checks every row of the kind against its arm, and keeps a row
 * whose arm the process's plugins lack (its plugin removed, or not listed
 * here) without reading it. Arms live beside their readers under
 * `@shared/plugins/`, which webviews import.
 */
interface PluginArm {
  /** The plugin's id: an arm is its own plugin's, never another's. */
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: z.ZodType;
  readonly upcasters: readonly ((value: JsonValue) => JsonValue)[];
  /** The kind's own transition rule, checked by the store in the writing
   *  transaction against the aggregate's latest row of the kind (none
   *  before the first): the refusal's reason, or null to admit. */
  readonly admits?: (
    previous: PluginRow | undefined,
    next: PluginRow,
  ) => string | null;
  /** The workspace files a row of the kind says its run wrote past the
   *  editor's own write path: every process that folds the run announces
   *  them (`workspaceFilesWritten`), a window hearing a service task's
   *  write as it hears its own. */
  readonly writes?: (value: JsonValue) => readonly string[];
}

/**
 * One plugin: what it contributes to a run. How an app shows it (a
 * dashboard card's copy, its setup guide, its settings rows) is the app's
 * own record, keyed by `id` (TeXRA's is `@tools/pluginCards`).
 */
export interface Plugin {
  /** Stable, persisted identifier (the switch key, the plugin a run's
   *  offered tool records, and the name of its `resources/plugins/<id>/`
   *  directory): lowercase letters, digits and dashes, starting with a
   *  letter or digit. A list with any other id is refused. */
  readonly id: string;
  /** Its tools, by registered name. */
  readonly tools?: Readonly<Record<string, RuntimeTool>>;
  /**
   * Present when the plugin has an external dependency: it is probed, and
   * its tools are withheld while the dependency is missing. Without it the
   * plugin is built in and always available.
   */
  readonly availability?: ToolAvailabilityChecks;
  /** The plugin has a user switch, which a fresh install sets to this
   *  position; while off, its tools are withheld from every agent. It must
   *  be probed (`availability`, `ALWAYS_AVAILABLE` when it needs nothing
   *  installed). Without one the plugin is always on. */
  readonly toggle?: 'on' | 'off';
  /** Tools of this plugin offered to every agent with tools, declared or not,
   *  while the plugin is on and a boolean catalog setting is on: tool name to
   *  setting key, or `true` for no setting but the plugin's own switch. An
   *  injected tool still passes the host and approval gates; a script's
   *  run (a document task's) and a text-only persona get none. */
  readonly injectedWhen?: Readonly<Record<string, string | true>>;
  /** Decides what a parked run of its category does next; a run's step pins
   *  it while the plugin is switched on. */
  readonly continuation?: Continuation;
  /** Its section of each request's system text; a run's step pins it while
   *  the plugin is switched on. */
  readonly prompt?: PromptSection;
  /** Process-lifetime services, up while the plugin is switched on or a step
   *  pins it (`@tools/liveTools`). A host-supplied one (Copilot's, in VS
   *  Code) is passed with the host's plugin value. */
  readonly processLayer?: ProcessPluginLayer;
  /** Session-lifetime services, one per open session, up while the plugin
   *  is switched on or a step of that session pins it. */
  readonly sessionLayer?: SessionPluginLayer;
  /** Its side of a decision on a pending request of the kind it owns, run
   *  whether or not it is switched on: the request outlives the switch. */
  readonly decision?: RequestDecisionHook;
  /** The row kinds it owns (`plugin.fact`), whether or not it is switched
   *  on: its rows outlive the switch. */
  readonly arms?: readonly PluginArm[];
}

/**
 * A plugin as its author writes it: its tools, continuation and probe may
 * require `ROut`, the services its own layers serve, beside the harness's.
 * `definePlugin` checks that at compile time (a tool that needs a service no
 * layer of its plugin serves does not compile) and erases it: the table
 * holds every plugin alike, and the step that pins a plugin provides its
 * layers' services to its calls.
 */
export interface PluginDefinition<ROut> extends Omit<
  Plugin,
  'tools' | 'continuation' | 'processLayer' | 'sessionLayer' | 'availability'
> {
  readonly tools?: Readonly<
    Record<string, RuntimeTool<Error, ToolServices | ROut>>
  >;
  readonly continuation?: Continuation<ROut>;
  readonly processLayer?: ProcessPluginLayer<ROut>;
  readonly sessionLayer?: Layer.Layer<ROut, never, Runs | PluginHold>;
  /** Probed outside any step, whether or not the plugin is on: it may
   *  require only the process's probe services. Its own process services
   *  are offered while its layer is up, read with `Effect.serviceOption`. */
  readonly availability?: ToolAvailabilityChecks;
}

/** A plugin value from its definition, its own services erased. */
export const definePlugin = <ROut = never>(
  plugin: PluginDefinition<ROut>,
): Plugin => plugin as unknown as Plugin;

const DisabledToolIdsSchema = z.array(z.string());

/**
 * The switch record as stored, checked: the ids the user holds off, or
 * `undefined` while nothing (neither the first-install seed nor the user)
 * has written it. A present value that is not a list of ids is corruption and
 * fails as the read, rather than reading as "nothing off", which would switch
 * every opt-in plugin on.
 */
export function storedDisabledTools(
  stored: unknown,
): Result.Result<ReadonlySet<string> | undefined, StateReadFailed> {
  if (stored === undefined) return Result.succeed(undefined);
  const parsed = DisabledToolIdsSchema.safeParse(stored);
  return parsed.success
    ? Result.succeed(new Set(parsed.data))
    : Result.fail(
        new StateReadFailed({
          key: GlobalStateKey.DISABLED_TOOLS,
          message: `The tool switch record (${GlobalStateKey.DISABLED_TOOLS}) is unreadable: ${z.prettifyError(parsed.error)}`,
          cause: parsed.error,
        }),
      );
}

/** The plugin ids the user switched off in `store`'s record; none while it
 *  is absent. */
export function readDisabledTools(store: StateStore) {
  return store.get(GlobalStateKey.DISABLED_TOOLS).pipe(
    Effect.flatMap((stored) => Effect.fromResult(storedDisabledTools(stored))),
    Effect.map((ids): ReadonlySet<string> => ids ?? new Set()),
  );
}

/**
 * Announce the workspace files every run's facts say it wrote above `since`
 * (an arm's `writes`), once each and in commit order: a run that changes
 * the workspace past the editor's own write path records it as a fact on
 * its own rows, and every process that folds the run announces it, so a
 * window hears a `texra serve` task's change as it hears its own. The view
 * only says which runs to look at: a run whose announced fact differs from
 * the last level read, the first level included. The rows themselves are
 * read (`rows`), since the view keeps each kind's latest value only and its
 * tail coalesces wakes; a row at or below `since` (the history a reopened
 * session replays) is never announced. A failed read (a busy store) is
 * logged and retried on the next change, from where the last good read left
 * off: it never stops the announcer.
 */
export function announceRunFacts(
  changes: Stream.Stream<SessionView>,
  rows: (runId: RunId) => Effect.Effect<readonly SessionEvent[], Error>,
  since: CommitOrdinal,
  arms: PluginArms,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const writing = new Map(
      Object.entries(arms).flatMap(([name, { writes }]) =>
        writes === undefined ? [] : [[name, writes] as const],
      ),
    );
    const seen = new Map<RunId, string>();
    const announcedTo = new Map<RunId, CommitOrdinal>();
    const announce = (runId: RunId) =>
      rows(runId).pipe(
        Effect.map((stored) => {
          let last = announcedTo.get(runId) ?? since;
          for (const row of stored) {
            if (row.type !== 'plugin.fact' || row.commit <= last) continue;
            const writes = writing.get(`${row.plugin}/${row.kind}`);
            if (writes !== undefined)
              emitAppSignal('workspaceFilesWritten', {
                absolutePaths: [...writes(row.value)],
              });
            last = row.commit;
          }
          announcedTo.set(runId, last);
        }),
        Effect.catch((error) => {
          seen.delete(runId);
          return Effect.logWarning(
            `Run ${runId}'s facts were not read; announcing them on the next change`,
          ).pipe(Effect.annotateLogs({ data: error }));
        }),
      );
    return Stream.runForEach(changes, (view) => {
      const moved: RunId[] = [];
      for (const run of view.runs.values()) {
        const facts = [...writing.keys()].map((key) => run.facts[key]);
        if (facts.every((fact) => fact === undefined)) continue;
        const written = JSON.stringify(facts);
        if (seen.get(run.id) === written) continue;
        seen.set(run.id, written);
        moved.push(run.id);
      }
      return Effect.forEach(moved, announce, { discard: true });
    });
  });
}

/** The plugin arms a store reads, by `plugin/kind`. */
export type PluginArms = Readonly<Record<string, PluginArm>>;

/**
 * The arms `plugins` contribute, by `plugin/kind`. An arm of another
 * plugin's id, or a kind contributed twice, is a defect of the plugin list.
 */
export function armsOf(plugins: Iterable<Plugin>): PluginArms {
  const arms = new Map<string, PluginArm>();
  for (const { id, arms: own = [] } of plugins)
    for (const arm of own) {
      const name = `${arm.plugin}/${arm.kind}`;
      if (arm.plugin !== id || arms.has(name))
        throw new Error(
          `The plugin list is not valid: plugin ${id} contributes the row kind ${name}, which is not its own or is contributed twice.`,
        );
      arms.set(name, arm);
    }
  return Object.fromEntries(arms);
}

/**
 * Throw unless every fact a call of `plugin`'s tool states is a row of one of
 * that plugin's own arms, at the arm's version, with a value its schema
 * accepts: the dispatch turns the throw into the call's error result, so a
 * fact the store could not read back, or one that would mark the store as
 * written by a newer build, never commits.
 */
export function checkOwnFacts(
  plugin: Plugin | undefined,
  facts: readonly ToolFact[],
): void {
  for (const { kind, version, value, ...fact } of facts) {
    const arm = plugin?.arms?.find((own) => own.kind === kind);
    if (arm === undefined || fact.plugin !== plugin?.id)
      throw new Error(`the fact ${fact.plugin}/${kind} is not its plugin's`);
    if (version !== arm.version)
      throw new Error(`${arm.plugin}/${kind} is at version ${arm.version}`);
    arm.schema.parse(value);
  }
}
