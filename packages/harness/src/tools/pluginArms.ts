/**
 * `PLUGIN_EVENT_ARMS`: each plugin's own row kinds. A plugin writes a row of its
 * kinds as a `plugin.fact` draft through the one publisher and reads it
 * back through its own reader. The store checks each stored row against its
 * arm, and keeps a row whose arm this build lacks (its plugin removed, or not
 * installed here) without reading it (`Database`). The arms live
 * beside their readers under `@shared/plugins/`, which webviews can import.
 */

import { DOCUMENTS_OUTPUT_ARM } from '@shared/plugins/documents';
import { EXTERNAL_INQUIRY_THREAD_ARM } from '@shared/plugins/externalInquiry';
import { GOAL_STATE_ARM } from '@shared/plugins/goal';
import type { JsonValue, RunId } from '@shared/schemas';
import type { z } from 'zod';

/** What a transition rule reads of a row: its value and its parent edge. */
interface PluginRow {
  readonly value: JsonValue;
  readonly parent: RunId | null;
}

/** One row kind of one plugin: the version it writes, the schema of that
 *  version's value, and the adjacent upcasters (`upcasters[i]` maps version
 *  `i + 1` to `i + 2`) the row codec reads an older value through. */
interface PluginArm {
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: z.ZodType;
  readonly upcasters: readonly ((value: JsonValue) => JsonValue)[];
  /** The kind's own transition rule, checked by the store in the writing
   *  transaction against the aggregate's latest row of the kind (none
   *  before the first): the refusal's reason, or null to admit. */
  readonly admits?: (
    previous: PluginRow | undefined,
    next: PluginRow,
  ) => string | null;
}

const PLUGIN_EVENT_ARMS: readonly PluginArm[] = [
  GOAL_STATE_ARM,
  DOCUMENTS_OUTPUT_ARM,
  EXTERNAL_INQUIRY_THREAD_ARM,
];

/** Every built-in plugin's arms, by `plugin/kind`. */
export const PLUGIN_ARMS: ReadonlyMap<string, PluginArm> = new Map(
  PLUGIN_EVENT_ARMS.map((arm) => [`${arm.plugin}/${arm.kind}`, arm]),
);
