// Current workflow-script phase for orientation chrome (header, status bar).

import { AgentCategory, type StreamTabId } from '@shared/schemas';
import type { TranscriptRowOf } from '@shared/transcript';
import {
  formatWorkflowPhaseHeading,
  type WorkflowPhaseHeading,
} from '@shared/copy/workflowCall';

import { currentWorkflowAttemptId, type StreamSlice } from './cliState';

/**
 * The open phase of one workflow-script stream, if it has emitted one.
 * `category` is the stream's shared-metadata agent category; callers read it
 * (`streamMetadataFor(id)?.agentCategory`) so this selector stays pure.
 */
export function currentWorkflowPhaseHeading(
  slice: StreamSlice | undefined,
  category: AgentCategory | undefined,
): WorkflowPhaseHeading | undefined {
  if (!slice || category !== AgentCategory.Workflow) return undefined;
  const currentAttemptId = currentWorkflowAttemptId(
    slice.workflowAttemptId,
    slice.entries,
    slice.workflowAttemptBoundaryDeclared,
  );
  const phase = slice.entries.findLast(
    (row): row is TranscriptRowOf<'phase'> =>
      row.kind === 'phase' &&
      (currentAttemptId === undefined ||
        (currentAttemptId !== null && row.attemptId === currentAttemptId)),
  );
  if (!phase) return undefined;
  return {
    phaseLabel: phase.phaseLabel,
    phaseIndex: phase.phaseIndex,
    phaseTotal: phase.phaseTotal,
  };
}

/** Nearest workflow-script ancestor's current phase, walking parent links. */
export function ancestorWorkflowPhaseHeading(init: {
  readonly categoryOf: (streamId: StreamTabId) => AgentCategory | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): WorkflowPhaseHeading | undefined {
  let id: StreamTabId | undefined = init.streamId;
  const seen = new Set<StreamTabId>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const heading = currentWorkflowPhaseHeading(
      init.streams.get(id),
      init.categoryOf(id),
    );
    if (heading) return heading;
    id = init.parentStream.get(id);
  }
  return undefined;
}

/** Status-bar location while a nested session is focused. */
export function focusedSessionLocationText(init: {
  readonly isChildStream: boolean;
  readonly label: string;
  readonly phaseHeading?: WorkflowPhaseHeading;
}): string | undefined {
  if (!init.isChildStream) return undefined;
  return init.phaseHeading
    ? `${formatWorkflowPhaseHeading(init.phaseHeading)} › ${init.label}`
    : init.label;
}
