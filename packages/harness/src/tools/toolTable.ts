/**
 * The process's plugin table: the plugin list an entry passes to
 * `processLayer`, by plugin id, and each tool by name. What a plugin
 * contributes to the tool catalog is read off its value. The `ToolRegistry` service holds it, beside
 * the catalog built over it. This module imports no tool or plugin layer, so
 * a reader of the tag loads none of them.
 */
// Node imports
import * as path from 'node:path';

// Third-party imports
import {
  Context,
  Effect,
  FileSystem,
  type Layer,
  type Path,
  type PlatformError,
  Schema,
} from 'effect';

// Local imports
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { InboxItem } from '@agent/followUp/Inbox';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import type { AgentEntry } from '@agent/index/agentEntry';
import type { AppSignals } from '@platform/appSignals';
import type { AppState } from '@platform/interfaces';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { GlobalValues } from '@platform/processRuntime';
import type { ConfigProvider } from '@shared/config/settings';
import {
  AgentDefinitionSchema,
  type PluginRequest,
  type RequestDecision,
  type RunId,
  type ToolFact,
} from '@shared/schemas';
import type { ToolCatalog } from '@tools/liveTools';
import { readNormalizedFile } from '@utils/files/fsDurability';
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
 * A top-level block a plugin owns in an agent file (such as `task:`). The
 * catalog scan checks a file's block against `schema`
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
  readonly schema: Schema.Codec<A, unknown>;
  /** How a run of this block's recipe reads to whoever launched it. */
  readonly result?: AgentBlockResult<R>;
  /** The files the block binds, relative to its agent file: part of the
   *  agent, so a customized copy carries them and the file's digest covers
   *  them. */
  files?(block: A): readonly string[];
}

/**
 * How a completed recipe run reads: to the launching model, and to a
 * script's summary of the files its calls wrote. What it reports is the
 * run's latest row of the plugin's own `fact` kind (`Plugin.factKinds`),
 * the one record of it; the recipe's return value is not read. The harness
 * reads the row only through these.
 */
export interface AgentBlockResult<R = unknown> {
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

/** The files the blocks of an agent file bind (`AgentBlock.files`),
 *  relative to it, in block order; `owners` is the plugin table's blocks. */
export function boundFiles(
  blocks: Readonly<Record<string, unknown>>,
  owners: ReadonlyMap<string, AgentBlock>,
): readonly string[] {
  return Object.entries(blocks).flatMap(
    ([key, value]) => owners.get(key)?.files?.(value) ?? [],
  );
}

/**
 * The file an agent file at `agentPath` binds as `file`: where it is
 * (beside the agent file, or an absolute path as written) and how to read
 * it. A file that cannot be read fails the read; every reader of a bound
 * file goes through this, so none mistakes a missing file for an empty or
 * a changed one.
 */
export function boundFile(
  agentPath: string,
  file: string,
): {
  readonly path: string;
  readonly read: Effect.Effect<
    string,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  >;
} {
  const boundPath = path.resolve(path.dirname(agentPath), file);
  return {
    path: boundPath,
    read: Effect.flatMap(FileSystem.FileSystem, (fs) =>
      readNormalizedFile(fs, boundPath),
    ),
  };
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
 *  prompt section and layers) is read off its value. */
export interface ToolTable {
  /** Every plugin, in the order the app listed them. */
  readonly entries: ReadonlyMap<string, Plugin>;
  /** The tool registered under `name` in any plugin, typed as plugins
   *  declare their tools (`Plugin.tools`). */
  readonly get: (name: string) => ITool<Error, PluginToolServices> | undefined;
  /** The agent-file blocks the plugins own, by key (`Plugin.agentBlock`). */
  readonly blocks: ReadonlyMap<string, AgentBlock>;
}

/** The probe of a switched plugin that names none: it needs nothing. */
const NEEDS_NOTHING: NonNullable<Plugin['availability']> = {
  check: () => Effect.succeed({ available: true }),
};

/**
 * The table over `plugins`, which the app lists in order. A list that
 * spells an id other than lowercase letters, digits and dashes, repeats a
 * plugin id, a tool name or a script module's name, claims an agent-file
 * block another plugin or the persona owns, or lacks a plugin another
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
  const owned = plugins.flatMap(({ agentBlock }) => agentBlock ?? []);
  const blocks = new Map(owned.map((block) => [block.key, block] as const));
  if (
    blocks.size !== owned.length ||
    owned.some(({ key }) => key in AgentDefinitionSchema.fields)
  )
    refuse('an agent-file key is owned twice, or is a persona key.');
  const modules = plugins.flatMap(({ scriptModules = {} }) =>
    Object.keys(scriptModules),
  );
  if (new Set(modules).size !== modules.length)
    refuse('two plugins ship a script module of one name.');
  return { entries, get: (name) => byName.get(name), blocks };
}

/** The process's plugin table, which every run's offered tools come from. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra-ai/harness/tools/ToolRegistry',
) {}
