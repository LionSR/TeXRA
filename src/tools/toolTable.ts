/**
 * The process's plugin table: every plugin's tools by plugin id, which each
 * run's offered tools are rebuilt from (`@tools/composition`). The
 * `ToolRegistry` service holds it, provided once per process by
 * `installProcessRuntime` from `@tools/registry`, beside the compositions
 * built over it. This module imports no tool, manifest or plugin layer, so
 * a reader of the tag loads none of them.
 */
import { Context, type Layer } from 'effect';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';

/**
 * The resources a plugin owns, as a layer: built when the first open
 * composition that includes the plugin opens, released when the last one
 * closes (`@tools/compositions`). One object per plugin for the life of the
 * process, which is what lets compositions share it. Its services are
 * erased in this type (and it may neither fail nor require a service): no
 * plugin declares a layer yet, and the first one that does types its
 * services into the tool contract's requirements.
 */
export type PluginLayer = Layer.Layer<never>;

/** Every plugin's tools, and every tool by name. */
export interface ToolTable {
  /** Each plugin's tools by registered name, keyed by plugin id. */
  readonly plugins: ReadonlyMap<string, ReadonlyMap<string, ITool>>;
  /** The layer of each plugin that owns resources, keyed by plugin id. */
  readonly layers: ReadonlyMap<string, PluginLayer>;
  /** The tool registered under `name` in any plugin. */
  readonly get: (name: string) => ITool | undefined;
}

/** A table over plugin id → (tool name → tool), and plugin id → layer. */
export function toolTable(
  plugins: Readonly<Record<string, Readonly<Record<string, ITool>>>>,
  layers: Readonly<Record<string, PluginLayer>> = {},
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
    get: (name) => byName.get(name),
  };
}

/** The process's plugin table, which every run's offered tools come from. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra/tools/ToolRegistry',
) {}
