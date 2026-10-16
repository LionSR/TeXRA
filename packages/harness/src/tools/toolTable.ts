/**
 * The process's plugin table: the plugin list an entry passes to
 * `processLayer`, by plugin id, and each tool by name. What a plugin
 * contributes to the tool catalog is read off its value. The `ToolRegistry` service holds it, beside
 * the catalog built over it. This module imports no tool or plugin layer, so
 * a reader of the tag loads none of them.
 */
import {
  Context,
  type Effect,
  type FileSystem,
  type Layer,
  type Path,
} from 'effect';

import type { RunInbox } from '@agent/followUp/ToolUseFollowUp';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import type {
  LogWriteError,
  SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { AgentEntry } from '@agent/index/agentEntry';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import type { AppState, ConfigProvider } from '@platform/interfaces';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  AgentDefinitionSchema,
  type PermissionPayload,
  type RequestDecision,
  type RunId,
  type ToolFact,
} from '@shared/schemas';
import type { GlobalDatabase } from '@shared/session/database';
import type { RunState } from '@shared/session/runStateFold';
import type { ToolCatalog } from '@tools/liveTools';
import type { McpServerPlugin } from '@tools/mcp/mcpConfig';
import type { Plugin } from '@tools/plugins';
import type { z } from 'zod';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * What a plugin's process layer is built over: the tool catalog it belongs
 * to, and the process's filesystem, paths, child processes and application
 * state (a language server pool spawns and reads its settings).
 */
export type PluginLayerServices =
  | ToolCatalog
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | AppState;

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
>()('@texra/tools/PluginHold') {}

/**
 * An installed plugin a step loads while it is enabled and trusted: its MCP
 * servers, if any, whose tools the catalog contributes under its one id and every
 * tool-use run is offered, and the plugin as read, whose
 * skills the step lists. Its servers are held under its trust digest
 * (`source.trust.digest`), which changes exactly when what it would start
 * or ship does, and so replaces them.
 */
interface InstalledToolPlugin {
  readonly id: string;
  readonly servers: readonly McpServerPlugin[];
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
 * each step beside its tools; with none, the run
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

/**
 * A plugin's side of a decision on a pending request of the kind it owns
 * (the external inquiry's answer, recorded on its cross-project thread). The
 * session runs it before the decision's row commits, under the request's
 * decision lane, so a process that exits in between leaves the request
 * pending and answerable rather than settled with nothing recorded. It may
 * send a run of the session its input (`inbox`), and commit facts about its
 * own aggregates, hung under the request's run (`commit`).
 */
export interface RequestDecisionHook {
  /** The request kind whose decisions this plugin records. */
  readonly kind: PermissionPayload['kind'];
  readonly record: (request: {
    readonly payload: PermissionPayload;
    readonly decision: RequestDecision;
    readonly inbox: (runId: RunId) => RunInbox;
    readonly commit: (
      facts: readonly (ToolFact & { readonly aggregate: string })[],
    ) => Effect.Effect<void, LogWriteError>;
  }) => Effect.Effect<void, Error, GlobalDatabase>;
}

/**
 * A top-level block a plugin owns in an agent file (TeXRA's documents plugin
 * owns `task:`). The catalog scan checks a file's block against `schema`
 * and keeps the parsed value on the entry (`AgentEntry.blocks`); a file
 * whose block fails it, or that holds a key no listed plugin owns, is
 * refused like any other invalid definition. An agent with a block is a
 * task: it declares no tools, delegation marks it for the tools that
 * `launchesTasks`, and it runs as one only through a launch its plugin
 * builds (a `script` of kind `recipe`). The harness reads nothing inside it.
 */
export interface AgentBlock<A = unknown, R = unknown> {
  /** The key in an agent file: unique across the plugin list, and never a
   *  key of the persona itself. */
  readonly key: string;
  /** The block as written, to its value with defaults applied. */
  readonly schema: z.ZodType<A>;
  /** How a run of this block's recipe reads to whoever launched it. */
  readonly result?: AgentBlockResult<R>;
}

/**
 * How a recipe's return value (its run's `output.structured`) reads: to the
 * launching model, and to a script's summary of the files its calls wrote.
 * The harness reads the value only through these.
 */
export interface AgentBlockResult<R = unknown> {
  /** Checks the value where it is read; a value that fails it is delivered
   *  as an invalid result naming the issue, never shaped. */
  readonly schema: z.ZodType<R>;
  /** The delivery body inside the harness's own result envelope. */
  delivery(value: R, runId: RunId): readonly string[];
  /** The files the recipe wrote, in the order it wrote them (a document
   *  revised twice appears twice, the later entry its latest): the files a
   *  parent may read of its child's storage, and a script's summary. */
  changes(
    value: R,
    roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
  ): readonly RecipeChange[];
}

/** One file a recipe wrote, as a script summary counts it. */
export interface RecipeChange {
  /** The workspace path the file replaces. */
  readonly path: string;
  /** The file the recipe wrote. */
  readonly absolutePath: string;
  /** The file it was diffed against, when it continues one: an earlier
   *  call's `absolutePath` continues that call's row. */
  readonly base: string | null;
  readonly added: number | null;
  readonly removed: number | null;
}

/** The value of `block` on `entry`, as the catalog scan parsed it with the
 *  block's schema; undefined when the agent has none. */
export function agentBlockOf<A>(
  entry: Pick<AgentEntry, 'blocks'>,
  block: AgentBlock<A>,
): A | undefined {
  // cast: the scan stored this key's value as `block.schema` parsed it.
  return entry.blocks[block.key] as A | undefined;
}

/** The process's plugins by plugin id: what each contributes (its tools,
 *  continuation, prompt section and layers) is read off its value. */
export interface ToolTable {
  /** Every plugin, in the order the app listed them. */
  readonly entries: ReadonlyMap<string, Plugin>;
  /** The tool registered under `name` in any plugin. */
  readonly get: (name: string) => ITool | undefined;
  /** Each request kind's decision hook, from the plugin that owns it. */
  readonly decisions: ReadonlyMap<string, RequestDecisionHook>;
  /** The agent-file blocks the plugins own, by key (`Plugin.agentBlock`). */
  readonly blocks: ReadonlyMap<string, AgentBlock>;
}

/**
 * The table over `plugins`, which the app lists in order. A list that
 * spells an id other than lowercase letters, digits and dashes, repeats a
 * plugin id or a tool name, claims the parked runs'
 * continuation or one request kind's decisions twice, claims an agent-file
 * block another plugin or the persona owns, or gives a switch to a plugin
 * with no availability probe is a defect of the list, refused when it is
 * built.
 */
export function toolTable(plugins: readonly Plugin[]): ToolTable {
  const entries = new Map<string, Plugin>();
  const byName = new Map<string, ITool>();
  let continued: string | null = null;
  const decisions = new Map<string, RequestDecisionHook>();
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
    if (plugin.decision !== undefined) {
      if (decisions.has(plugin.decision.kind))
        refuse(
          `plugin ${plugin.id} records ${plugin.decision.kind} decisions, which another plugin already does.`,
        );
      decisions.set(plugin.decision.kind, plugin.decision);
    }
    if (plugin.availability === undefined && plugin.toggle !== undefined)
      refuse(`plugin ${plugin.id} has a switch but no availability probe.`);
  }
  const owned = plugins.flatMap(({ agentBlock }) => agentBlock ?? []);
  const blocks = new Map(owned.map((block) => [block.key, block] as const));
  if (
    owned.some(
      (block, index) =>
        owned.findIndex(({ key }) => key === block.key) !== index ||
        block.key in AgentDefinitionSchema.shape,
    )
  )
    refuse('an agent-file key is owned twice, or is a persona key.');
  return { entries, get: (name) => byName.get(name), decisions, blocks };
}

/** The process's plugin table, which every run's offered tools come from. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra/tools/ToolRegistry',
) {}
