/**
 * `PLUGIN_EVENT_ARMS`: each plugin's own row kinds. A plugin writes a row of its
 * kinds as a `plugin.fact` draft through the one publisher and reads it
 * back through its own reader; a kind that changes the workspace past the
 * editor's own write path is announced as an app signal by every process
 * that folds it (`announceRunFacts`). The store checks each stored row against its
 * arm, and keeps a row whose arm this build lacks (its plugin removed, or not
 * installed here) without reading it (`Database`). The arms live
 * beside their readers under `@shared/plugins/`, which webviews can import.
 */

import { Effect, Stream } from 'effect';

import { emitAppSignal } from '@eventBus/AppSignals';
import {
  acceptedPathsOf,
  DOCUMENTS_ACCEPTED_ARM,
  DOCUMENTS_ACCEPTED_KEY,
  DOCUMENTS_OUTPUT_ARM,
} from '@shared/plugins/documents';
import { EXTERNAL_INQUIRY_THREAD_ARM } from '@shared/plugins/externalInquiry';
import { GOAL_STATE_ARM } from '@shared/plugins/goal';
import type { JsonValue, RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
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
  DOCUMENTS_ACCEPTED_ARM,
  EXTERNAL_INQUIRY_THREAD_ARM,
];

/** Every built-in plugin's arms, by `plugin/kind`. */
export const PLUGIN_ARMS: ReadonlyMap<string, PluginArm> = new Map(
  PLUGIN_EVENT_ARMS.map((arm) => [`${arm.plugin}/${arm.kind}`, arm]),
);

/**
 * The app signals a run's facts announce, by `RunView.facts` key. A run that
 * changes the workspace past the editor's own write path (files it
 * accepted) records it as a fact on its own rows, and every process
 * that folds the run announces it to its own listeners: a window hears a
 * `texra serve` task's change as it hears its own, from the rows.
 */
const ANNOUNCED: Readonly<Record<string, (value: unknown) => void>> = {
  [DOCUMENTS_ACCEPTED_KEY]: (value) =>
    emitAppSignal('workspaceFilesWritten', {
      absolutePaths: acceptedPathsOf(value),
    }),
};

/**
 * Announce each announced fact a run commits from the view this stream
 * starts at: what the first level holds is not new. Values are compared as
 * written, so a view rebuilt from the same rows announces nothing.
 */
export function announceRunFacts(
  changes: Stream.Stream<SessionView>,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    let seen: ReadonlyMap<string, string> | undefined;
    return Stream.runForEach(changes, (view) =>
      Effect.sync(() => {
        const now = new Map<string, string>();
        const changed: (() => void)[] = [];
        for (const run of view.runs.values()) {
          for (const [key, announce] of Object.entries(ANNOUNCED)) {
            const value = run.facts[key];
            if (value === undefined) continue;
            const id = `${run.id}/${key}`;
            const written = JSON.stringify(value);
            now.set(id, written);
            if (seen !== undefined && seen.get(id) !== written)
              changed.push(() => announce(value));
          }
        }
        seen = now;
        for (const announce of changed) announce();
      }),
    );
  });
}
