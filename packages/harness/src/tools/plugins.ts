/**
 * A plugin: what one unit of the harness contributes (its tools, the probe
 * of its dependency, its switch, its prompt section and layers). The harness's built-ins are `harnessBuiltins`; an app
 * passes its list, built-ins included, to `processLayer`, and the
 * process's `ToolRegistry` holds it, which every
 * reader takes it from: availability probes, the first-install switch seed,
 * the switches, a run's injected tools, and the bundled skills and agents
 * at `resources/plugins/<id>/`, which a switched-off plugin withholds with
 * its tools. How the app shows a plugin is its own record, keyed by id. An
 * installed plugin's native entry (`harness.mjs`) returns one too, loaded
 * while the process runs (`@tools/nativePlugins`): it joins the table a run
 * reads from its next step, and has no row kinds, switch, probe or
 * injected tools.
 *
 * Rules: an id is persisted (the disabled-tools key, and the plugin a run's
 * offered tool records), so it never changes and is never reused; every
 * tool belongs to exactly one plugin (checked when the table is built). No
 * hooks or second event channels. A program
 * (`programs`) is one of its script modules, started by name. A plugin
 * holds state only in its process or session layer and writes rows only of
 * its own kinds (`factKinds`), through the one publisher.
 */

// Third-party imports
import { Cause, Effect, type Layer, Schema } from 'effect';

// Local imports
import type { ITool } from '@tools/core/ToolTypes';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { withLogChannel } from '@logger/effectLog';
import { type AppSignals, emitAppSignal } from '@platform/appSignals';
import {
  type RunId,
  type SessionRow,
  type SessionRowDraft,
  type ToolFact,
  factName,
  type FactName,
} from '@shared/schemas';
import type { SettingRow } from '@shared/state/stateSettings';
import type { ToolAvailabilityChecks } from '@tools/toolProbes';
import type {
  PluginHold,
  ProcessPluginLayer,
  Program,
  PromptSection,
  SessionPluginLayer,
} from '@tools/toolTable';

/**
 * One row kind a plugin owns (`plugin.fact`): the version it writes and
 * reads, and the schema of that version's value; a stored row at a lower
 * version is an earlier build's, and one at a higher version refuses the
 * store. The store checks every row of the kind against its fact kind, and
 * reads a row whose fact kind the process's plugins lack (its plugin
 * removed, or not listed here) as written, marked `unavailable`; a run
 * holding one does not resume. Fact kinds live beside their readers, in
 * modules webviews can import.
 */
export interface FactKind {
  /** The plugin's id: a fact kind is its own plugin's, never another's. */
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: Schema.Codec<unknown, unknown>;
  /** What a fork of a run (a conversation's, or a script's `self()` child)
   *  starts with of the run's row of the kind: `copy` the row the run held
   *  at the cut, `drop` none. */
  readonly fork: 'copy' | 'drop';
  /** The workspace files a row of the kind says its run wrote past the
   *  editor's own write path: every process that folds the run announces
   *  them (`workspaceFilesWritten`), a window hearing a service task's
   *  write as it hears its own. */
  readonly writes?: (value: Schema.Json) => readonly string[];
}

/**
 * One plugin: what it contributes to a run. How an app shows it (a
 * dashboard card's copy, its setup guide, its settings rows) is the app's
 * own record, keyed by `id`.
 */
export interface Plugin {
  /** Stable, persisted identifier (the switch key, the plugin a run's
   *  offered tool records, and the name of its `resources/plugins/<id>/`
   *  directory): lowercase letters, digits and dashes, starting with a
   *  letter or digit. A list with any other id is refused. */
  readonly id: string;
  /** Its tools, registered by each tool's `definition.name`, in order. */
  readonly tools?: readonly ITool<Error, PluginToolServices>[];
  /**
   * Present when the plugin has an external dependency: it is probed, and
   * while the dependency is missing a run is offered none of its tools, is
   * told of none of its programs and reads no prompt section of its.
   * Without it the plugin is built in and always available.
   */
  readonly availability?: ToolAvailabilityChecks;
  /** The plugin has a user switch, which a fresh install sets to this
   *  position; while off, its tools are withheld from every agent. A
   *  switched plugin with no `availability` is probed as needing nothing.
   *  Without a switch the plugin is always on. */
  readonly toggle?: 'on' | 'off';
  /** Tools of this plugin offered to every agent with tools, declared or not,
   *  while the plugin is on and a boolean catalog setting is on: tool name to
   *  setting row, or `true` for no setting but the plugin's own switch. An
   *  injected tool still passes the host and approval gates; a script's
   *  run (a program) and a text-only run get none. */
  readonly injectedWhen?: Readonly<Record<string, SettingRow<boolean> | true>>;
  /** Its section of each request's system text, pinned while it is on. */
  readonly prompt?: PromptSection;
  /** Process-lifetime services, up while the plugin is switched on or a step
   *  pins it. A host-supplied one (VS Code's setup commands) is passed with
   *  the host's plugin value. */
  readonly processLayer?: ProcessPluginLayer;
  /** Session-lifetime services, one per open session, up while the plugin
   *  is switched on or a step of that session pins it. */
  readonly sessionLayer?: SessionPluginLayer;
  /** The row kinds it owns (`plugin.fact`), on or off: rows outlive it. */
  readonly factKinds?: readonly FactKind[];
  /** Script module sources by name, imported as `builtIn:<name>`. */
  readonly scriptModules?: Readonly<Record<string, string>>;
  /** Those of its `scriptModules` a person or a model starts by name
   *  (`Program`), each under its module's name. */
  readonly programs?: Readonly<Record<string, Program>>;
  /** The plugins it runs on, by id; a list lacking one is rejected. */
  readonly requires?: readonly string[];
}

/**
 * A plugin as its author writes it: its tools, layers and probe may
 * require `ROut`, the services its own layers serve, beside the harness's.
 * `definePlugin` checks that at compile time (a tool that needs a service no
 * layer of its plugin serves does not compile) and erases it: the table
 * holds every plugin alike, and the step that pins a plugin provides its
 * layers' services to its calls. */
export interface PluginDefinition<ROut> extends Omit<
  Plugin,
  'tools' | 'processLayer' | 'sessionLayer' | 'availability'
> {
  readonly tools?: readonly ITool<Error, PluginToolServices | ROut>[];
  readonly processLayer?: ProcessPluginLayer<ROut>;
  readonly sessionLayer?: Layer.Layer<ROut, never, PluginHold>;
  /** Probed outside any step, whether or not the plugin is on: it may
   *  require only the process's probe services. Its own process services
   *  are offered while its layer is up, read with `Effect.serviceOption`. */
  readonly availability?: ToolAvailabilityChecks;
}

/** `value` with every array and object literal it is built of frozen, down
 *  to the first value of another kind (a schema, a layer, a function), which
 *  is its own module's to keep. One its owner froze at the top is still
 *  read through; `seen` ends a cycle. */
const frozenLiterals = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (typeof value !== 'object' || value === null || seen.has(value))
    return value;
  seen.add(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) || prototype === Object.prototype) {
    Object.freeze(value);
    for (const child of Object.values(value)) frozenLiterals(child, seen);
  }
  return value;
};

/** A plugin value from its definition, its own services erased: the
 *  harness's built-ins and an app's plugins are written the same way. The
 *  value is `plugin` itself, frozen with the arrays and records it is
 *  written with (its tools, its probe, its programs): every session of the
 *  process shares the one definition, and none can change it for the
 *  others. */
export const definePlugin = <ROut = never>(
  plugin: PluginDefinition<ROut>,
): Plugin =>
  // The step that pins the plugin serves its layers' services to its calls.
  // cast: `ROut` is checked by the parameter type and erased here.
  frozenLiterals(plugin) as unknown as Plugin;

/**
 * Announce the workspace files a committed row says its run wrote past the
 * editor's own write path (a fact kind's `writes`): a run records such a change
 * as a fact on its own rows, and every process that reads the run's rows
 * announces it (`workspaceFilesWritten`), so a window hears a background
 * service task's change as it hears its own. Run over the session's applied
 * tail, so each row is announced once, in commit order, and the history a
 * reopened session replays never as news.
 */
export const announceWrites = (
  factKinds: FactKinds,
): ((row: SessionRow) => Effect.Effect<void, never, AppSignals>) => {
  const writing = new Map(
    Object.entries(factKinds).flatMap(([name, { writes }]) =>
      writes === undefined ? [] : [[name, writes] as const],
    ),
  );
  return (row) => {
    if (row.type !== 'plugin.fact') return Effect.void;
    const writes = writing.get(factName(row));
    if (writes === undefined) return Effect.void;
    // File notifications are advisory; a plugin callback must not stop the
    // reader that acknowledges committed rows.
    return Effect.sync(() => [...writes(row.value)]).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning(
          'Plugin workspace-write notification failed',
          Cause.die(defect),
        ).pipe(
          Effect.annotateLogs({
            data: {
              plugin: row.plugin,
              kind: row.kind,
              aggregateId: row.aggregateId,
              commit: row.commit,
            },
          }),
          withLogChannel('plugins'),
        ),
      ),
      Effect.flatMap((absolutePaths) =>
        absolutePaths === undefined
          ? Effect.void
          : emitAppSignal('workspaceFilesWritten', { absolutePaths }),
      ),
    );
  };
};

/** The plugin fact kinds a store reads, by `plugin/kind`. */
export type FactKinds = Readonly<Record<FactName, FactKind>>;

/**
 * Throw unless every fact a call of `plugin`'s tool states is a row of one of
 * that plugin's own fact kinds, at the kind's version, with a value its
 * schema accepts: the dispatch turns the throw into the call's error result, so a
 * fact the store could not read back, or one that would mark the store as
 * written by a newer build, never commits.
 */
export function checkOwnFacts(
  toolName: string,
  plugin: Plugin | undefined,
  facts: readonly ToolFact[],
): void {
  for (const { kind, version, value, ...fact } of facts) {
    if (plugin === undefined)
      throw new Error(
        `the tool ${toolName} states the fact ${fact.plugin}/${kind}, but no loaded plugin offers it`,
      );
    const factKind = plugin.factKinds?.find((own) => own.kind === kind);
    if (factKind === undefined || fact.plugin !== plugin.id)
      throw new Error(`the fact ${fact.plugin}/${kind} is not its plugin's`);
    if (version !== factKind.version)
      throw new Error(
        `${factKind.plugin}/${kind} is at version ${factKind.version}`,
      );
    Schema.decodeUnknownSync(factKind.schema)(value);
  }
}

/**
 * The rows a call's facts commit under `runId`, in the batch that records
 * what they are facts of (its `tool.result`), so each commits with that
 * record or not at all.
 */
export const factRows = (
  facts: readonly ToolFact[],
  runId: RunId,
): readonly Extract<SessionRowDraft, { type: 'plugin.fact' }>[] =>
  facts.map((fact) => ({ type: 'plugin.fact', ...fact, aggregateId: runId }));
