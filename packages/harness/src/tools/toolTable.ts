/**
 * The process's plugin table: the plugin list an entry passes to
 * `processLayer`, by plugin id, and each tool by name. What a plugin
 * contributes to the tool catalog is read off its value. The `ToolRegistry` service holds it, beside
 * the catalog built over it. This module imports no tool or plugin layer, so
 * a reader of the tag loads none of them.
 */
// Third-party imports
import {
  Context,
  Effect,
  type FileSystem,
  type Layer,
  type Path,
  type Schema,
} from 'effect';

// Local imports
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { InboxItem } from '@agent/followUp/Inbox';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import type { AppSignals } from '@platform/appSignals';
import type { AppState } from '@platform/interfaces';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { GlobalValues } from '@platform/processRuntime';
import type { ConfigProvider } from '@shared/config/settings';
import type {
  PluginRequest,
  RequestDecision,
  RunId,
  ToolFact,
} from '@shared/schemas';
import type { ToolCatalog } from '@tools/liveTools';
import type { Plugin } from '@tools/plugins';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * What a plugin's process layer is built over: the tool catalog it belongs
 * to, and the process's filesystem, paths, child processes, application
 * state (a language server pool spawns and reads its settings) and signal
 * hub (the GitHub subscriptions announce their bindings).
 */
export type PluginLayerServices =
  | ToolCatalog
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | AppState
  | AppSignals;

/**
 * A plugin's process-lifetime services (its `processLayer`): built
 * when the plugin is switched on or first pinned, released when it is
 * switched off and no step uses it. `ROut` is what it
 * serves its own plugin's code (`definePlugin`); the table holds it erased.
 * `drain` is its step of the core shutdown protocol, run before the
 * sessions close while its services are still up.
 */
export interface ProcessPluginLayer<ROut = never> {
  readonly layer: Layer.Layer<ROut, never, PluginLayerServices>;
  readonly drain?: Effect.Effect<void, never, ROut>;
}

/**
 * A plugin's session-lifetime services (its `sessionLayer`): one build
 * per open session, up while the plugin is switched on, a step of that
 * session pins it, or work it started holds it (`PluginHold`), and closed
 * with the session. It reads no run: a plugin reaches runs through its
 * tools' `ChildRuns`.
 */
export type SessionPluginLayer = Layer.Layer<never, never, PluginHold>;

/**
 * Keep the session layer that provides this service up until `until` ends:
 * for work a plugin starts that outlives the step that started it (an agent
 * CLI's detached child), so switching the plugin off does not drop state
 * that work still owns. The hold is taken before this returns.
 */
export class PluginHold extends Context.Service<
  PluginHold,
  (until: Effect.Effect<void>) => Effect.Effect<void>
>()('@texra-ai/harness/tools/PluginHold') {}

/**
 * A plugin's section of each request's system text, rendered from the tool
 * names the request's step offers, whether the run is a child and its
 * workspace configuration ('' for none).
 */
export type PromptSection = (ctx: {
  readonly offered: readonly string[];
  readonly isChild: boolean;
  /** The step's bound model is an Anthropic model. */
  readonly isAnthropic: boolean;
  /** The run's workspace configuration, for a section that follows a
   *  setting of its plugin's. */
  readonly config: ConfigProvider;
}) => string;

/**
 * A plugin's side of a decision on a pending request it opened (a
 * `PluginRequest` naming it), run before the decision commits: what the
 * plugin records outside the session's store, and what commits with the
 * decision in its one checked transaction ({@link RequestDecisionRecord}).
 * The outside record must be idempotent: an answer tried again after a
 * failure, or raced by another, records nothing twice, and the second
 * reads the first's. A process that exits before the transaction leaves
 * the request pending and answerable.
 */
export interface RequestDecisionHook {
  readonly record: (request: {
    readonly payload: PluginRequest;
    readonly decision: RequestDecision;
  }) => Effect.Effect<RequestDecisionRecord, Error, GlobalValues>;
}

/** What commits with a plugin request's decision, in its transaction
 *  ({@link RequestDecisionHook}). */
export interface RequestDecisionRecord {
  /** Facts about the plugin's own aggregates, hung under the request's run
   *  and checked in the transaction: one its kind refuses is logged and
   *  left out. */
  readonly facts: readonly (ToolFact & { readonly aggregate: string })[];
  /** The input the plugin sends a run of the session, admitted in the
   *  transaction (one the run's closed input refuses is logged), the run
   *  woken for it once that commits. */
  readonly followUp?: { readonly runId: RunId; readonly item: InboxItem };
}

/**
 * One of a plugin's script modules that a person or a model starts by name
 * (`Plugin.programs`): the module's default export is
 * `async (args) => result`, and a run opened on it
 * (`AgentConfig.script` of kind `program`) is a script run that imports the
 * module and calls that export with the launch's `args`, its instruction
 * and its files. The plugin wrote
 * it, not a model, so the launch that chose it granted it: its tools are
 * the listed ones past any switch, its `agent` calls run under the launch's
 * approval, and its prompts and files pass as written.
 */
export interface Program<R = unknown> {
  /** One line: what the program does and the `args` it reads. The script
   *  tool's description lists it. */
  readonly description: string;
  /** The tools its run is offered, by name. */
  readonly tools: readonly string[];
  /** How a completed run of it reads to whoever launched it. Without one,
   *  the run delivers its reply alone. */
  readonly result?: ProgramResult<R>;
  /** The files its run writes when its launch names none, for a program
   *  that creates documents (a deck, a transcript) and does not rewrite
   *  its inputs. */
  readonly outputs?: readonly string[];
}

/**
 * How a completed program run reads: to the launching model, and to a
 * script's summary of the files its calls wrote. What it reports is the
 * run's latest row of the plugin's own `fact` kind (`Plugin.factKinds`),
 * the one record of it; the program's return value is not read. The harness
 * reads the row only through these.
 */
export interface ProgramResult<R = unknown> {
  /** The plugin's row kind that records what the run did, and the schema
   *  its value decodes with. A completed run with no such row, or one that
   *  fails the schema, is delivered as an invalid result naming the issue,
   *  never shaped. */
  readonly fact: {
    readonly plugin: string;
    readonly kind: string;
    readonly schema: Schema.Codec<R, unknown>;
  };
  /** The delivery body inside the harness's own result envelope. */
  delivery(value: R, runId: RunId): readonly string[];
  /** The files the program wrote, in the order it wrote them (a document
   *  revised twice appears twice, the later entry its latest): the files a
   *  parent may read of its child's storage, and a script's summary. */
  changes(
    value: R,
    roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
  ): readonly ProgramChange[];
}

/** One file a program wrote, as a script summary counts it. */
export interface ProgramChange {
  /** The workspace path the file replaces. */
  readonly path: string;
  /** The file the program wrote. */
  readonly absolutePath: string;
  /** The file it was diffed against, when it continues one: an earlier
   *  call's `absolutePath` continues that call's row. */
  readonly base: string | null;
  readonly added: number | null;
  readonly removed: number | null;
}

/** The process's plugins by plugin id: what each contributes (its tools,
 *  prompt section and layers) is read off its value. */
export interface ToolTable {
  /** Every plugin, in the order the app listed them. */
  readonly entries: ReadonlyMap<string, Plugin>;
  /** The tool registered under `name` in any plugin, typed as plugins
   *  declare their tools (`Plugin.tools`). */
  readonly get: (name: string) => ITool<Error, PluginToolServices> | undefined;
  /** The programs the plugins register, by name (`Plugin.programs`). */
  readonly programs: ReadonlyMap<string, Program>;
}

/** The probe of a switched plugin that names none: it needs nothing. */
const NEEDS_NOTHING: NonNullable<Plugin['availability']> = {
  check: () => Effect.succeed({ available: true }),
};

/**
 * The table over `plugins`, which the app lists in order. A list that
 * spells an id other than lowercase letters, digits and dashes, repeats a
 * plugin id, a tool name or a script module's name, registers a program
 * that is not one of its own script modules, or lacks a plugin another
 * `requires` is a defect of the list, rejected when it is built. A plugin
 * with a switch and no availability probe is probed as needing nothing.
 */
export function toolTable(plugins: readonly Plugin[]): ToolTable {
  const entries = new Map<string, Plugin>();
  const byName = new Map<string, ITool<Error, PluginToolServices>>();
  const refuse = (reason: string): never => {
    throw new Error(`The plugin list is not valid: ${reason}`);
  };
  for (const plugin of plugins) {
    // The id names its resources directory and its switch: one plain path
    // segment, so it can neither escape nor alias another plugin's.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin.id))
      refuse(
        `plugin id ${JSON.stringify(plugin.id)} is not lowercase letters, digits and dashes.`,
      );
    if (entries.has(plugin.id)) refuse(`plugin ${plugin.id} is listed twice.`);
    entries.set(
      plugin.id,
      plugin.toggle !== undefined && plugin.availability === undefined
        ? { ...plugin, availability: NEEDS_NOTHING }
        : plugin,
    );
    for (const tool of plugin.tools ?? []) {
      const { name } = tool.definition;
      if (byName.has(name))
        refuse(`tool ${name} of plugin ${plugin.id} is already registered.`);
      byName.set(name, tool);
    }
  }
  const [missing] = plugins.flatMap(({ id, requires }) =>
    (requires ?? []).flatMap((needed) =>
      entries.has(needed) ? [] : [`plugin ${id} runs on plugin ${needed}`],
    ),
  );
  if (missing !== undefined) refuse(`${missing}, which is not listed.`);
  const modules = plugins.flatMap(({ scriptModules = {} }) =>
    Object.keys(scriptModules),
  );
  if (new Set(modules).size !== modules.length)
    refuse('two plugins ship a script module of one name.');
  // A program is started by its module's name, which the check above keeps
  // unique across the list.
  const programs = new Map<string, Program>();
  for (const { id, programs: own = {}, scriptModules = {} } of plugins)
    for (const [name, program] of Object.entries(own)) {
      if (!Object.hasOwn(scriptModules, name))
        refuse(`program ${name} of plugin ${id} is not one of its modules.`);
      programs.set(name, program);
    }
  return { entries, get: (name) => byName.get(name), programs };
}

/** The process's plugin table, which every run's offered tools come from. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra-ai/harness/tools/ToolRegistry',
) {}
