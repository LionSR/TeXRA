/**
 * The process's plugin table: every plugin's tools by plugin id, which each
 * run's offered tools are rebuilt from (`@tools/composition`). The
 * `ToolRegistry` service holds it, provided once per process by
 * `installProcessRuntime` from `@tools/registry`. This module imports no
 * tool and no manifest, so a reader of the tag loads neither.
 */
import { Context } from 'effect';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';

/** Every plugin's tools, and every tool by name. */
export interface ToolTable {
  /** Each plugin's tools by registered name, keyed by plugin id. */
  readonly plugins: ReadonlyMap<string, ReadonlyMap<string, ITool>>;
  /** The tool registered under `name` in any plugin. */
  readonly get: (name: string) => ITool | undefined;
}

/** A table over plugin id → (tool name → tool). */
export function toolTable(
  plugins: Readonly<Record<string, Readonly<Record<string, ITool>>>>,
): ToolTable {
  const byName = new Map(Object.values(plugins).flatMap(Object.entries));
  return {
    plugins: new Map(
      Object.entries(plugins).map(([id, tools]) => [
        id,
        new Map(Object.entries(tools)),
      ]),
    ),
    get: (name) => byName.get(name),
  };
}

/** The process's plugin table, which every run's offered tools come from. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra/tools/ToolRegistry',
) {}
