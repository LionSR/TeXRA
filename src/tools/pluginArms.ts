/**
 * `PLUGIN_EVENT_ARMS`: each plugin's own row kinds, keyed by plugin id and
 * checked against the manifest's `rows` flag. A plugin writes a row of its
 * kinds as a `plugin.fact` draft through the one publisher and reads it
 * back through its own reader. The store checks each stored row against its
 * arm, and keeps a row whose arm this build lacks (its plugin removed, or not
 * installed here) without reading it (`Database`). The arms live
 * beside their readers under `@shared/plugins/`, which webviews can import.
 */

import { GOAL_STATE_ARM } from '@shared/plugins/goal';
import type { ToolPluginEntry } from '@tools/plugins';
import type { z } from 'zod';

/** One row kind of one plugin, and the schema of its value. */
interface PluginArm {
  readonly plugin: string;
  readonly kind: string;
  readonly schema: z.ZodType;
}

const PLUGIN_EVENT_ARMS = {
  goal: [GOAL_STATE_ARM],
} as const satisfies {
  readonly [
    Id in Extract<ToolPluginEntry, { readonly rows: true }>['id']
  ]: readonly (PluginArm & { readonly plugin: Id })[];
};

/** Every built-in plugin's arms, by `plugin/kind`. */
export const PLUGIN_ARMS: ReadonlyMap<string, PluginArm> = new Map(
  Object.values(PLUGIN_EVENT_ARMS)
    .flat()
    .map((arm) => [`${arm.plugin}/${arm.kind}`, arm]),
);
