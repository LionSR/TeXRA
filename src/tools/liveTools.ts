/**
 * The process's live tool catalog: a `Registry` (`@tools/liveRegistry`) of
 * every tool some plugin currently contributes, keyed by tool name.
 *
 * - **Built-in plugins** contribute their manifest table while their switch
 *   is on. `sync` reconciles the contributions with the user's switches: a
 *   plugin switched off withdraws its tools, one switched on contributes
 *   them again, and each change is a new generation on `current`. A run's
 *   step syncs before it pins (`@agent/runtime/loop/step`), so a switch
 *   flipped by any host, or by `texra tools` from another shell, reaches
 *   every open run at its next step.
 * - **Loaded plugins** (MCP servers, `@tools/toolTable`) contribute the tools
 *   their server listed while some run holds them (`hold`). Holds are
 *   counted per spec and revision, so runs naming the same server share one
 *   process, which stops with the last hold. A reloaded server's new
 *   revision supersedes the older one in the catalog while both run.
 * - **Plugin layers** are built per pinned generation through one `MemoMap`,
 *   so the generations that share a plugin share one build of its layer,
 *   released when the last generation holding it drains.
 *
 * Each entry carries its identity, the digest of its name and input schema
 * with its plugin's id and revision, which a call is checked against before
 * it runs; and the digest of its definition as shown, which a step records
 * with the identity as what it offered.
 */
import { createHash } from 'node:crypto';

import {
  Context,
  Effect,
  Equal,
  Exit,
  Hash,
  Layer,
  RcMap,
  Scope,
  SynchronizedRef,
} from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import stableStringify from 'safe-stable-stringify';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { toolDefinitionsFor } from '@agent/runtime/run/tools';
import {
  makeRegistry,
  type Generation,
  type Registry,
} from '@tools/liveRegistry';
import {
  ToolRegistry,
  type LoadedPlugin,
  type PluginLoader,
  type ToolTable,
} from '@tools/toolTable';
import { isObject } from '@utils/core';

/** One tool in the catalog, with the identity a step records. */
export interface ToolEntry {
  readonly tool: ITool;
  /** The contributing plugin's id. */
  readonly plugin: string;
  /** The plugin's revision, which rows record, so the same in every
   *  process: a digest of its tools' identities for a built-in plugin, of
   *  its spec for a loaded one. A loaded plugin's keyed revision (its env
   *  values) is fresh per process and only counts its holds. */
  readonly revision: string;
  /** What this process built the entry from, never recorded: a loaded
   *  plugin's hold, so two holds of one revision (edited env values) are
   *  different generations, whose pins never share a server process. */
  readonly build: string;
  /** The tool's identity: sha256 over its name and input schema, every
   *  description left out. A call runs only while its tool still has it. */
  readonly digest: string;
  /** sha256 over the definition as the model is shown it, descriptions
   *  included: a change is recorded as a new offered set, and rejects no
   *  call. */
  readonly shown: string;
}

export type ToolGeneration = Generation<string, ToolEntry>;

/** What a hold found for each loaded plugin the declarations name. */
export interface HeldPlugins {
  /** The configuration problems the read found. */
  readonly warnings: readonly string[];
  /** Each configured plugin by id, with why it offers no tools, if so. */
  readonly loaded: ReadonlyMap<string, string | undefined>;
}

export class LiveTools extends Context.Service<
  LiveTools,
  {
    readonly registry: Registry<string, ToolEntry, Context.Context<never>>;
    /** Contribute exactly the built-in plugins not switched `off`. */
    readonly sync: (off: ReadonlySet<string>) => Effect.Effect<void>;
    /** Hold the loaded plugins `declared` names until the caller's scope
     *  closes; their tools are in the catalog while held. */
    readonly hold: (
      declared: readonly string[],
    ) => Effect.Effect<HeldPlugins, never, Scope.Scope>;
  }
>()('@texra/tools/LiveTools') {}

const sha256 = (value: unknown): string =>
  createHash('sha256')
    .update(stableStringify(value) ?? '')
    .digest('hex');

/** Keywords whose value is one schema, or an array of schemas. */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'prefixItems',
  'additionalProperties',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'contentSchema',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'anyOf',
  'oneOf',
  'allOf',
]);

/** Keywords whose value maps a name to a schema: keys are data, kept as is. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
]);

/**
 * A JSON Schema node with the `description` keyword dropped at every schema
 * position. It walks keywords, not keys: a property named `description` is a
 * name in a `properties` map and stays, and `enum`/`const`/`default` values
 * are data and are not entered.
 */
function withoutSchemaDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutSchemaDescriptions);
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === 'description') continue;
    if (SUBSCHEMA_KEYWORDS.has(keyword)) {
      out[keyword] = withoutSchemaDescriptions(value);
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
      out[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          withoutSchemaDescriptions(schema),
        ]),
      );
    } else {
      out[keyword] = value;
    }
  }
  return out;
}

/**
 * A tool's identity digest and the digest of its definition as a request
 * carries it. The identity is the name and input schema only: a description,
 * the tool's own or a schema node's, can change without invalidating a call
 * the model already made.
 */
export const toolDigests = (
  tool: ITool,
): { readonly digest: string; readonly shown: string } => {
  const [definition] = toolDefinitionsFor([tool.definition]);
  return {
    digest: sha256({
      name: definition!.name,
      parameters: withoutSchemaDescriptions(definition!.parameters),
    }),
    shown: sha256(definition),
  };
};

/** A plugin's tools as catalog entries under one revision; `loaded` is
 *  the hold a loaded plugin's tools come from. */
const entriesOf = (
  plugin: string,
  tools: ReadonlyMap<string, ITool>,
  loaded?: LoadedKey,
): ReadonlyMap<string, ToolEntry> => {
  const digests = [...tools].map(
    ([name, tool]) => [name, tool, toolDigests(tool)] as const,
  );
  // A built-in plugin's revision is over its tools' identities, so a
  // description edit is not a new revision either.
  const revision = loaded
    ? sha256(loaded.plugin.spec)
    : sha256(digests.map(([name, , { digest }]) => [name, digest]));
  const build = loaded?.id ?? revision;
  return new Map(
    digests.map(([name, tool, digests]) => [
      name,
      { tool, plugin, revision, build, ...digests },
    ]),
  );
};

/** One spec revision of a loaded plugin: the key its holds are counted by. */
class LoadedKey implements Equal.Equal {
  readonly id: string;
  constructor(readonly plugin: LoadedPlugin) {
    this.id = `${plugin.id}#${sha256(plugin.spec)}#${plugin.revision}`;
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof LoadedKey && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

const liveToolsLayer = (
  loader: PluginLoader,
): Layer.Layer<LiveTools, never, ToolRegistry | ChildProcessSpawner> =>
  Layer.effect(
    LiveTools,
    Effect.gen(function* () {
      const table: ToolTable = yield* ToolRegistry;
      const spawner = yield* ChildProcessSpawner;
      const scope = yield* Effect.scope;
      const memoMap = yield* Layer.makeMemoMap;
      const registry = yield* makeRegistry<
        string,
        ToolEntry,
        Context.Context<never>
      >({
        digest: (entries) =>
          sha256(
            [...entries]
              .map(([name, e]) => [name, e.digest, e.shown, e.plugin, e.build])
              .toSorted(([a], [b]) => Number(a > b) - Number(a < b)),
          ),
        acquire: (generation) =>
          Effect.flatMap(Effect.scope, (pinScope) =>
            Layer.buildWithMemoMap(
              [...new Set(generation.owners.values())].reduce<
                Layer.Layer<never>
              >((merged, id) => {
                const layer = table.layers.get(id);
                return layer ? Layer.merge(merged, layer) : merged;
              }, Layer.empty),
              memoMap,
              pinScope,
            ),
          ),
      });

      // Each built-in plugin's open contribution, by id: its scope closes
      // when the plugin is switched off.
      const builtIns = yield* SynchronizedRef.make(
        new Map<string, Scope.Closeable>(),
      );
      const sync = (off: ReadonlySet<string>) =>
        SynchronizedRef.updateEffect(builtIns, (open) =>
          Effect.gen(function* () {
            const next = new Map(open);
            for (const [id, tools] of table.plugins) {
              const on = !off.has(id);
              const held = next.get(id);
              if (on && held === undefined) {
                const contribution = yield* Scope.fork(scope);
                // The manifest rules out a name two plugins share, so a
                // conflict between built-in plugins is a defect.
                yield* registry
                  .contribute(id, entriesOf(id, tools))
                  .pipe(Scope.provide(contribution), Effect.orDie);
                next.set(id, contribution);
              } else if (!on && held !== undefined) {
                yield* Scope.close(held, Exit.void);
                next.delete(id);
              }
            }
            return next;
          }),
        );
      yield* sync(new Set());

      const servers = yield* RcMap.make({
        lookup: (key: LoadedKey) =>
          Effect.gen(function* () {
            const answered = yield* key.plugin.acquire.pipe(
              Effect.provideService(ChildProcessSpawner, spawner),
            );
            if (answered.failure !== undefined) return answered.failure;
            // Withdrawn when the last hold of this revision closes.
            return yield* registry
              .contribute(
                key.plugin.id,
                entriesOf(key.plugin.id, answered.tools, key),
              )
              .pipe(
                Effect.as(undefined),
                Effect.catchTag('RegistryConflict', (conflict) =>
                  Effect.succeed(
                    `${key.plugin.id} was not loaded: ${conflict.message}`,
                  ),
                ),
              );
          }),
      });
      const hold = Effect.fn('LiveTools.hold')(function* (
        declared: readonly string[],
      ) {
        const read = yield* loader(declared);
        const loaded = new Map<string, string | undefined>();
        for (const plugin of read.plugins)
          loaded.set(
            plugin.id,
            yield* RcMap.get(servers, new LoadedKey(plugin)),
          );
        return { warnings: read.warnings, loaded };
      });
      return { registry, sync, hold };
    }),
  );

/** A loader for a process that loads no plugins from configuration. */
const noLoadedPlugins: PluginLoader = () =>
  Effect.succeed({ plugins: [], warnings: [] });

/**
 * `table` as the `ToolRegistry`, and the live catalog over it and the
 * plugins `loader` reads (none when omitted).
 */
export const toolTableLayer = (
  table: ToolTable,
  loader: PluginLoader = noLoadedPlugins,
): Layer.Layer<LiveTools | ToolRegistry, never, ChildProcessSpawner> =>
  liveToolsLayer(loader).pipe(
    Layer.provideMerge(Layer.succeed(ToolRegistry)(table)),
  );
