/**
 * The process's plugin table: the plugin list an entry passes to
 * `installProcessRuntime` (TeXRA's is `texraPlugins` in `@tools/registry`),
 * by plugin id, and each tool by name. What a plugin contributes to the live catalog (`@tools/liveTools`)
 * is read off its value. The `ToolRegistry` service holds it, beside
 * the catalog built over it. This module imports no tool or plugin layer, so
 * a reader of the tag loads none of them.
 */
import {
  Context,
  type Effect,
  type FileSystem,
  type Layer,
  type Path,
  type Scope,
} from 'effect';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import type { Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import type { AppState, ConfigProvider } from '@platform/interfaces';
import type { RunId } from '@shared/schemas';
import type { RunState } from '@shared/session/runStateFold';
import type { LiveTools } from '@tools/liveTools';
import type { Plugin } from '@tools/plugins';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * What a plugin's process layer is built over: the live catalog it belongs
 * to, and the process's filesystem, paths, child processes and application
 * state (a language server pool spawns and reads its settings).
 */
export type PluginLayerServices =
  | LiveTools
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | AppState;

/**
 * A plugin's process-lifetime services (its `processLayer`): built
 * when the plugin is switched on or first pinned, released when it is
 * switched off and no step pins it (`@tools/liveTools`). `ROut` is what it
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
 * with the session. It may read the session's `Runs`.
 */
export type SessionPluginLayer = Layer.Layer<never, never, Runs | PluginHold>;

/**
 * Keep the session layer that provides this service up until `until` ends:
 * for work a plugin starts that outlives the step that started it (an agent
 * CLI's detached child), so switching the plugin off does not drop state
 * that work still owns. The hold is taken before this returns.
 */
export class PluginHold extends Context.Service<
  PluginHold,
  (until: Effect.Effect<void>) => Effect.Effect<void>
>()('@texra/tools/PluginHold') {}

/** What a loaded plugin's resources answer once up: its tools, or why none. */
export interface LoadedPluginTools {
  readonly tools: ReadonlyMap<string, ITool>;
  /** Why the plugin offers no tools (its server failed to start). */
  readonly failure?: string;
}

/**
 * A plugin read from user configuration rather than the manifest (an MCP
 * server): its tools are known only once its resources are up, so a run
 * that names it holds its `spec` and revision, and the catalog contributes
 * its tools while any run holds them (`@tools/liveTools`).
 */
export interface LoadedPlugin {
  /** Stable id, e.g. `mcp:<server>`. */
  readonly id: string;
  /** What the holds are counted by, with the revision. */
  readonly spec: Readonly<Record<string, unknown>>;
  /**
   * A keyed digest of what the spec leaves out (an MCP server's env values):
   * a changed revision is a new hold with fresh resources beside the open
   * ones. Keyed per process, so it reveals nothing about the values it
   * digests, and never recorded: an offered tool records its spec's digest.
   */
  readonly revision: string;
  /**
   * Bring the resources up in the given scope and answer the tools. Never
   * fails: a plugin that cannot start answers its `failure` instead.
   */
  readonly acquire: Effect.Effect<
    LoadedPluginTools,
    never,
    Scope.Scope | ChildProcessSpawner
  >;
}

/**
 * The loaded plugins a run's declared tool names reach, read fresh at each
 * resolution, and the configuration problems the read found.
 */
export type PluginLoader = (declared: readonly string[]) => Effect.Effect<{
  readonly plugins: readonly LoadedPlugin[];
  readonly warnings: readonly string[];
}>;

/**
 * An installed plugin a step loads while it is enabled and trusted: its MCP
 * servers, if any, whose tools the catalog contributes under its one id and every
 * tool-use run is offered (`@tools/liveTools`), and the plugin as read, whose
 * skills the step lists. `key` changes exactly when what it would start or
 * ship does, which replaces its servers and its skills.
 */
export interface InstalledToolPlugin {
  readonly id: string;
  readonly key: string;
  readonly servers: readonly LoadedPlugin[];
  readonly source: LoadablePlugin;
}

/**
 * The installed plugins that load now, read at each step, each with the
 * servers it starts (none for one that ships only skills), and why each
 * enabled one that does not load is held back.
 */
export type InstalledToolReader = Effect.Effect<{
  readonly plugins: readonly InstalledToolPlugin[];
  readonly warnings: readonly string[];
}>;

/**
 * What decides that a parked run continues, pinned by
 * each step beside its tools (`@agent/runtime/loop/step`); with none, the run
 * parks. `atIdle` answers the synthetic turn's text or null; `canContinue`
 * is false when the run ends here or a follow-up is queued. `onResume` runs
 * at a resumed activation's first step that pins it, before the activation
 * decides anything: continuation does not survive a resume on its own.
 */
export interface Continuation<R = never> {
  readonly atIdle: (park: {
    readonly session: SessionHandle;
    readonly runId: RunId;
    readonly state: RunState;
    readonly canContinue: boolean;
  }) => Effect.Effect<string | null, Error, R>;
  readonly onResume: (run: {
    readonly session: SessionHandle;
    readonly runId: RunId;
  }) => Effect.Effect<void, Error, R>;
}

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

/** The process's plugins by plugin id: what each contributes (its tools,
 *  continuation, prompt section and layers) is read off its value. */
export interface ToolTable {
  /** Every plugin, in the order the app listed them. */
  readonly entries: ReadonlyMap<string, Plugin>;
  /** The tool registered under `name` in any plugin. */
  readonly get: (name: string) => ITool | undefined;
}

/**
 * The table over `plugins`, which the app lists in order. A list that
 * spells an id other than lowercase letters, digits and dashes, repeats a
 * plugin id or a tool name, claims the parked runs'
 * continuation twice, or gives a switch to a plugin with no availability
 * probe is a defect of the list, refused when it is built.
 */
export function toolTable(plugins: readonly Plugin[]): ToolTable {
  const entries = new Map<string, Plugin>();
  const byName = new Map<string, ITool>();
  let continued: string | null = null;
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
    entries.set(plugin.id, plugin);
    for (const [name, tool] of Object.entries(plugin.tools ?? {})) {
      if (byName.has(name))
        refuse(`tool ${name} of plugin ${plugin.id} is another plugin's.`);
      byName.set(name, tool);
    }
    if (plugin.continuation !== undefined) {
      if (continued !== null)
        refuse(
          `plugin ${plugin.id} continues parked runs, which plugin ${continued} already does.`,
        );
      continued = plugin.id;
    }
    if (plugin.availability === undefined && plugin.toggle !== undefined)
      refuse(`plugin ${plugin.id} has a switch but no availability probe.`);
  }
  return { entries, get: (name) => byName.get(name) };
}

/** The process's plugin table, which every run's offered tools come from. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra/tools/ToolRegistry',
) {}
