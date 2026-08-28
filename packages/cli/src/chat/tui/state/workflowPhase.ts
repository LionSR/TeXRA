// Current workflow-script phase for orientation chrome (header, status bar).

import { AgentCategory, type StreamTabId } from '@shared/schemas';
import type { TranscriptRowOf } from '@shared/transcript';

import type { StreamSlice } from './cliState';

/**
 * The open phase of one workflow-script stream, if it has emitted one.
 * `category` is the stream's shared-metadata agent category; callers read it
 * (`streamMetadataFor(id)?.agentCategory`) so this selector stays pure.
 */
export function currentWorkflowPhaseHeading(
  slice: StreamSlice | undefined,
  category: AgentCategory | undefined,
): TranscriptRowOf<'phase'> | undefined {
  if (!slice || category !== AgentCategory.Workflow) return undefined;
  return slice.entries.findLast(
    (row): row is TranscriptRowOf<'phase'> => row.kind === 'phase',
  );
}

/** Nearest workflow-script ancestor's current phase, walking parent links. */
export function ancestorWorkflowPhaseHeading(init: {
  readonly categoryOf: (streamId: StreamTabId) => AgentCategory | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): TranscriptRowOf<'phase'> | undefined {
  let id: StreamTabId | undefined = init.streamId;
  const seen = new Set<StreamTabId>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const phase = currentWorkflowPhaseHeading(
      init.streams.get(id),
      init.categoryOf(id),
    );
    if (phase) return phase;
    id = init.parentStream.get(id);
  }
  return undefined;
}
