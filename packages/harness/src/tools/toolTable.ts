/**
 * The plugin table: the plugin list an entry passes to `processLayer`, with
 * the native plugins loaded now (`withNatives`), by plugin id, and each
 * tool by name. What a plugin contributes to the tool catalog is read off
 * its value. The `ToolRegistry` service holds one table: the listed
 * plugins' outside a run, and inside one the table its launch or its step
 * read (`@tools/liveTools` owns the current one). This module imports no
 * tool or plugin layer, so a reader of the tag loads none of them.
 */
// Third-party imports
import {
  Context,
  Effect,
  type FileSystem,
  type Layer,
  type Path,
  Result,
  type Schema,
} from 'effect';

// Local imports
import type { ITool } from '@tools/core/ToolTypes';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import type { AppSignals } from '@platform/appSignals';
import type { AppState } from '@platform/interfaces';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { ConfigProvider } from '@shared/config/settings';
import {
  factName,
  programOrigin,
  type FactName,
  type RunId,
} from '@shared/schemas';
import type { ToolCatalog } from '@tools/liveTools';
import type { FactKind, FactKinds, Plugin } from '@tools/plugins';
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
>()('@texra-ai/worldline/tools/PluginHold') {}

/**
 * A plugin's section of each request's system text, rendered from the tool
 * names the request's step offers, whether the run is a child and its
 * workspace configuration ('' for none).
 */
export type PromptSection = (ctx: {
  readonly offered: readonly string[];
  readonly isChild: boolean;
  /** The run's workspace configuration, for a section that follows a
   *  setting of its plugin's. */
  readonly config: ConfigProvider;
}) => string;

/**
 * One of a plugin's script modules that a person or a model starts by name
 * (`Plugin.programs`): the module's default export is
 * `async (args, launch) => result`, and a run opened on it
 * (`AgentConfig.script` of kind `program`) is a script run that imports the
 * module and calls that export with the launch's `args` and
 * `{ instruction, inputFiles, contextFiles, mediaFiles }`. A program that
 * returns text answers with it when it registers no `result`. The plugin wrote
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

/** The plugin table a run step reads: the app's listed plugins and the
 *  native plugins loaded at that read, by plugin id; what each contributes
 *  (its tools, prompt section and layers) is read off its value. */
export interface ToolTable {
  /** Every plugin, the listed ones in the order the app listed them, then
   *  the native ones. */
  readonly entries: ReadonlyMap<string, Plugin>;
  /** The tool registered under `name` in any plugin, typed as plugins
   *  declare their tools (`Plugin.tools`). */
  readonly get: (name: string) => ITool<Error, PluginToolServices> | undefined;
  /** The programs the plugins register, by name (`Plugin.programs`). */
  readonly programs: ReadonlyMap<string, Program>;
  /** The row kinds the plugins own, by `plugin/kind` (`Plugin.factKinds`):
   *  what a store opened in this process reads. A native plugin owns none. */
  readonly factKinds: FactKinds;
  /** The revision of the plugin `id`, which its layers are kept under and
   *  its tools' rows record: `builtin` for a listed plugin, and for a
   *  native one the revision it was loaded at (`NativePlugin`). */
  readonly revisionOf: (id: string) => string;
  /** The native plugins among `entries`, each with its revision, in the
   *  order they were accepted: what tells a native plugin from a listed
   *  one. */
  readonly natives: readonly NativePlugin[];
}

/**
 * A plugin an installed plugin's native entry returned, under that
 * installed plugin's id (`plugin:<name>`), and its revision: a digest of
 * the entry's path and the trust digest it was loaded at. A new revision
 * stands beside the old one, whose layers stay up while a step that pinned
 * them holds them.
 */
export interface NativePlugin {
  readonly plugin: Plugin;
  readonly revision: string;
}

/** The probe of a switched plugin that names none: it needs nothing. */
const NEEDS_NOTHING: NonNullable<Plugin['availability']> = {
  check: () => Effect.succeed({ available: true }),
};

/**
 * The table over `listed` and `natives`, or why it is not one. A listed
 * plugin's id is lowercase letters, digits and dashes; a native one's is
 * its installed plugin's, checked where it is loaded. Over both: a
 * repeated plugin id, tool name or script module name, a script module
 * named with a colon, a program that is not one of its plugin's script
 * modules, a row kind of another plugin's id or one already contributed,
 * or a plugin another `requires` that is missing.
 */
const tableOf = (
  listed: readonly Plugin[],
  natives: readonly NativePlugin[],
): Result.Result<ToolTable, string> => {
  const plugins = [...listed, ...natives.map(({ plugin }) => plugin)];
  const entries = new Map<string, Plugin>();
  const byName = new Map<string, ITool<Error, PluginToolServices>>();
  for (const plugin of plugins) {
    // A listed id names its resources directory and its switch: one plain
    // path segment, so it can neither escape nor alias another plugin's.
    if (listed.includes(plugin) && !/^[a-z0-9][a-z0-9-]*$/.test(plugin.id))
      return Result.fail(
        `plugin id ${JSON.stringify(plugin.id)} is not lowercase letters, digits and dashes.`,
      );
    if (entries.has(plugin.id))
      return Result.fail(`plugin ${plugin.id} is listed twice.`);
    entries.set(
      plugin.id,
      plugin.toggle !== undefined && plugin.availability === undefined
        ? { ...plugin, availability: NEEDS_NOTHING }
        : plugin,
    );
    for (const tool of plugin.tools ?? []) {
      const { name } = tool.definition;
      if (byName.has(name))
        return Result.fail(
          `tool ${name} of plugin ${plugin.id} is already registered.`,
        );
      byName.set(name, tool);
    }
  }
  const [missing] = plugins.flatMap(({ id, requires }) =>
    (requires ?? []).flatMap((needed) =>
      entries.has(needed) ? [] : [`plugin ${id} runs on plugin ${needed}`],
    ),
  );
  if (missing !== undefined)
    return Result.fail(`${missing}, which is not listed.`);
  const modules = plugins.flatMap(({ scriptModules = {} }) =>
    Object.keys(scriptModules),
  );
  if (new Set(modules).size !== modules.length)
    return Result.fail('two plugins ship a script module of one name.');
  // A name with a colon is a program read from a file (`<plugin>:<name>`,
  // `own:<name>`), so a plugin's module can never be mistaken for one.
  const qualified = modules.find((name) => programOrigin(name) !== 'listed');
  if (qualified !== undefined)
    return Result.fail(`script module ${qualified} has a colon in its name.`);
  // A program is started by its module's name, which the check above keeps
  // unique across the table.
  const programs = new Map<string, Program>();
  for (const { id, programs: own = {}, scriptModules = {} } of plugins)
    for (const [name, program] of Object.entries(own)) {
      if (!Object.hasOwn(scriptModules, name))
        return Result.fail(
          `program ${name} of plugin ${id} is not one of its modules.`,
        );
      programs.set(name, program);
    }
  const factKinds = new Map<FactName, FactKind>();
  for (const { id, factKinds: own = [] } of plugins)
    for (const factKind of own) {
      const name = factName(factKind);
      if (factKind.plugin !== id || factKinds.has(name))
        return Result.fail(
          `plugin ${id} contributes the row kind ${name}, which is not its own or is contributed twice.`,
        );
      factKinds.set(name, factKind);
    }
  const revisions = new Map(
    natives.map(({ plugin, revision }) => [plugin.id, revision]),
  );
  return Result.succeed({
    entries,
    get: (name) => byName.get(name),
    programs,
    factKinds: Object.fromEntries(factKinds),
    revisionOf: (id) => revisions.get(id) ?? 'builtin',
    natives,
  });
};

/**
 * The table over `plugins`, which the app lists in order. A list the
 * table refuses (`tableOf`) is a defect of the list, rejected when it is
 * built. A plugin with a switch and no availability probe is probed as
 * needing nothing.
 */
export function toolTable(plugins: readonly Plugin[]): ToolTable {
  const table = tableOf(plugins, []);
  if (Result.isFailure(table))
    throw new Error(`The plugin list is not valid: ${table.failure}`);
  return table.success;
}

/**
 * `listed` with the native plugins loaded now, each judged whole against
 * the table the ones accepted before it made: one whose tool or module
 * name another plugin holds, or that runs on a plugin the table lacks, is
 * withheld with its reason, and the rest load. The plugins are judged in
 * passes, in order of their ids, until a pass accepts none: one that runs
 * on a native plugin judged after it loads in the next pass, whatever the
 * names. What no pass accepts (a collision, a plugin nobody loads, or a
 * cycle of plugins that run on each other) is withheld with the reason its
 * last judgement gave. The same set gives the same table.
 */
export const withNatives = (
  listed: ToolTable,
  natives: readonly NativePlugin[],
): {
  readonly table: ToolTable;
  /** Each native plugin left out, with why. */
  readonly withheld: readonly {
    readonly native: NativePlugin;
    readonly reason: string;
  }[];
} => {
  const base = [...listed.entries.values()];
  let table = listed;
  const accepted: NativePlugin[] = [];
  let withheld = natives
    .toSorted((a, b) => (a.plugin.id < b.plugin.id ? -1 : 1))
    .map((native) => ({ native, reason: 'it was not judged' }));
  for (let progress = true; progress && withheld.length > 0;) {
    progress = false;
    const judged: typeof withheld = [];
    for (const { native } of withheld) {
      const next = tableOf(base, [...accepted, native]);
      if (Result.isFailure(next)) judged.push({ native, reason: next.failure });
      else {
        accepted.push(native);
        table = next.success;
        progress = true;
      }
    }
    withheld = judged;
  }
  return { table, withheld };
};

/** The plugin table: listed plugins alone where nothing is loaded (the
 *  process's, read outside any run), and inside a run the table its launch
 *  or its step read, which holds the native plugins loaded then. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra-ai/worldline/tools/ToolRegistry',
) {}
