/**
 * The process's plugin table: every plugin's tools and continuation by plugin
 * id, which the built-in plugins contribute to the live catalog
 * (`@tools/liveTools`). The `ToolRegistry` service holds it, provided once
 * per process by `installProcessRuntime` from `@tools/registry`, beside the
 * catalog built over it. This module imports no tool, manifest or plugin layer, so a
 * reader of the tag loads none of them.
 */
import { Context, type Effect, type Layer, type Scope } from 'effect';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentCategory, RunId } from '@shared/schemas';
import type { RunState } from '@shared/session/runStateFold';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/**
 * The resources a plugin owns, as a layer: built when the first pinned
 * catalog generation that includes the plugin is pinned, released when the
 * last one drains (`@tools/liveTools`). One object per plugin for the life
 * of the process, which is what lets generations share it. Its services are
 * erased in this type (and it may neither fail nor require a service): no
 * plugin declares a layer yet, and the first one that does types its
 * services into the tool contract's requirements.
 */
export type PluginLayer = Layer.Layer<never>;

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
 * What decides that a parked run of one agent category continues, pinned by
 * each step beside its tools (`@agent/runtime/loop/step`); with none, the run
 * parks. `atIdle` answers the synthetic turn's text or null. `canContinue`
 * is false when the run ends here or a follow-up is queued; `resumed` holds
 * until a resumed activation's first park is decided.
 */
export interface Continuation {
  readonly category: AgentCategory;
  readonly atIdle: (park: {
    readonly session: SessionHandle;
    readonly runId: RunId;
    readonly state: RunState;
    readonly canContinue: boolean;
    readonly resumed: boolean;
  }) => Effect.Effect<string | null, Error>;
}

/** Every plugin's tools, and every tool by name. */
export interface ToolTable {
  /** Each plugin's tools by registered name, keyed by plugin id. */
  readonly plugins: ReadonlyMap<string, ReadonlyMap<string, ITool>>;
  /** The layer of each plugin that owns resources, keyed by plugin id. */
  readonly layers: ReadonlyMap<string, PluginLayer>;
  /** The continuation of each plugin that contributes one, by plugin id. */
  readonly continuations: ReadonlyMap<string, Continuation>;
  /** The tool registered under `name` in any plugin. */
  readonly get: (name: string) => ITool | undefined;
}

/** A table over plugin id → tools, layer and continuation. */
export function toolTable(
  plugins: Readonly<Record<string, Readonly<Record<string, ITool>>>>,
  layers: Readonly<Record<string, PluginLayer>> = {},
  continuations: Readonly<Record<string, Continuation>> = {},
): ToolTable {
  const byName = new Map(Object.values(plugins).flatMap(Object.entries));
  return {
    plugins: new Map(
      Object.entries(plugins).map(([id, tools]) => [
        id,
        new Map(Object.entries(tools)),
      ]),
    ),
    layers: new Map(Object.entries(layers)),
    continuations: new Map(Object.entries(continuations)),
    get: (name) => byName.get(name),
  };
}

/** The process's plugin table, which every run's offered tools come from. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra/tools/ToolRegistry',
) {}
