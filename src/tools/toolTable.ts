/**
 * The process's plugin table: every plugin's tools, continuation, prompt
 * contribution and layers by plugin id, which the built-in plugins contribute to the live catalog
 * (`@tools/liveTools`). The `ToolRegistry` service holds it, provided once
 * per process by `installProcessRuntime` from `@tools/registry`, beside the
 * catalog built over it. This module imports no tool, manifest or plugin layer, so a
 * reader of the tag loads none of them.
 */
import { Context, type Effect, type Layer, type Scope } from 'effect';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import type { Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import type { PluginServices } from '@platform/processRuntime';
import type { AgentCategory, RunId } from '@shared/schemas';
import type { RunState } from '@shared/session/runStateFold';
import type { LiveTools } from '@tools/liveTools';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/**
 * A plugin's process-lifetime services (`PLUGIN_PROCESS_LAYERS`): built
 * when the plugin is switched on or first pinned, released when it is
 * switched off and no step pins it (`@tools/liveTools`). Its services are
 * erased here and typed as `PluginServices` where a step serves them.
 * `drain` is its step of the core shutdown protocol, run before the
 * sessions close while its services are still up.
 */
export interface ProcessPluginLayer {
  /** It may read the live catalog it belongs to. */
  readonly layer: Layer.Layer<never, never, LiveTools>;
  readonly drain?: Effect.Effect<void, never, PluginServices>;
}

/**
 * A plugin's session-lifetime services (`PLUGIN_SESSION_LAYERS`): one build
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
 * What decides that a parked run of one agent category continues, pinned by
 * each step beside its tools (`@agent/runtime/loop/step`); with none, the run
 * parks. `atIdle` answers the synthetic turn's text or null; `canContinue`
 * is false when the run ends here or a follow-up is queued. `onResume` runs
 * at a resumed activation's first step that pins it, before the activation
 * decides anything: continuation does not survive a resume on its own.
 */
export interface Continuation {
  readonly category: AgentCategory;
  readonly atIdle: (park: {
    readonly session: SessionHandle;
    readonly runId: RunId;
    readonly state: RunState;
    readonly canContinue: boolean;
  }) => Effect.Effect<string | null, Error, PluginServices>;
  readonly onResume: (run: {
    readonly session: SessionHandle;
    readonly runId: RunId;
  }) => Effect.Effect<void, Error, PluginServices>;
}

/**
 * A plugin's section of each request's system text, rendered from the tool
 * names the request's step offers and whether the run is a child ('' for
 * none).
 */
export type PromptSection = (ctx: {
  readonly offered: readonly string[];
  readonly isChild: boolean;
  /** The step's bound model is an Anthropic model. */
  readonly isAnthropic: boolean;
  /** The configured default bibliography, '' when unset. */
  readonly bibPath: string;
}) => string;

/** What a plugin adds to the system text of each request whose step pins
 *  it: its section, and whether the run's skill catalog lists the skills it
 *  ships. */
export interface PromptContribution {
  readonly section: PromptSection | null;
  readonly skills: boolean;
}

/** Every plugin's tools, and every tool by name. */
export interface ToolTable {
  /** Each plugin's tools by registered name, keyed by plugin id. */
  readonly plugins: ReadonlyMap<string, ReadonlyMap<string, ITool>>;
  /** Each plugin's process services, by plugin id. */
  readonly processLayers: ReadonlyMap<string, ProcessPluginLayer>;
  /** Each plugin's session services, by plugin id. */
  readonly sessionLayers: ReadonlyMap<string, SessionPluginLayer>;
  /** The continuation of each plugin that contributes one, by plugin id. */
  readonly continuations: ReadonlyMap<string, Continuation>;
  /** The prompt contribution of each plugin that makes one, by plugin id. */
  readonly prompt: ReadonlyMap<string, PromptContribution>;
  /** The tool registered under `name` in any plugin. */
  readonly get: (name: string) => ITool | undefined;
}

/** A table over plugin id → tools, continuation, prompt contribution and
 *  layers. */
export function toolTable(
  plugins: Readonly<Record<string, Readonly<Record<string, ITool>>>>,
  continuations: Readonly<Record<string, Continuation>> = {},
  prompt: Readonly<Record<string, PromptContribution>> = {},
  processLayers: Readonly<Record<string, ProcessPluginLayer>> = {},
  sessionLayers: Readonly<Record<string, SessionPluginLayer>> = {},
): ToolTable {
  const byName = new Map(Object.values(plugins).flatMap(Object.entries));
  return {
    plugins: new Map(
      Object.entries(plugins).map(([id, tools]) => [
        id,
        new Map(Object.entries(tools)),
      ]),
    ),
    continuations: new Map(Object.entries(continuations)),
    prompt: new Map(Object.entries(prompt)),
    processLayers: new Map(Object.entries(processLayers)),
    sessionLayers: new Map(Object.entries(sessionLayers)),
    get: (name) => byName.get(name),
  };
}

/** The process's plugin table, which every run's offered tools come from. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra/tools/ToolRegistry',
) {}
