// The rows of the workflow popup (`WorkflowPopup.tsx`): how one call, one
// unissued plan entry, and one counted group look in a terminal row.

import { Box, Text } from 'ink';

import { fillRows } from '@cli/runtime/terminalText';
import type { WorkflowCallIdentity } from '@shared/schemas';
import {
  formatWorkflowRowGroup,
  workflowPlanEntryLabel,
  type WorkflowPhaseRow,
} from '@shared/runs/workflowRunModel';
import type { WorkflowTaskRow as WorkflowTaskRowModel } from '@ui/transcript';
import { WORKFLOW_CALL_STATUS_GLYPH } from '@ui/copy/workflowCall';

import { ApprovalSegments, RowSegment } from './SubagentList';
import { pendingApprovalRowDisplay } from './SubagentListDisplay';
import { WORKFLOW_TASK_STATUS_COLOR } from './transcriptEntryLayout';
import type { PendingApprovalKind } from '../state/approvalQueue';

/** The three-column marker cell every popup row starts its text after, so a
 *  phase's rows line up whether or not one is focused. A glyph that counts as
 *  two columns takes its own cell instead of shoving the label right. */
function markerCell(marker: string): string {
  return fillRows(` ${marker}`, 3);
}

/** One call: its label and status word in full, then why it failed or what
 *  its child last said, cut to the width left. What the call is (kind,
 *  agent, model, spend) is the focused row's detail line, not every row's. */
export function TaskRow({
  latestLine,
  pendingKinds,
  row,
}: {
  readonly latestLine: string | undefined;
  readonly pendingKinds: readonly PendingApprovalKind[] | undefined;
  readonly row: WorkflowTaskRowModel;
}): React.JSX.Element {
  const approval = pendingApprovalRowDisplay(pendingKinds);
  const detail = row.detail?.text ?? latestLine;
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text aria-hidden color={WORKFLOW_TASK_STATUS_COLOR[row.call.status]}>
          {markerCell(WORKFLOW_CALL_STATUS_GLYPH[row.call.status])}
        </Text>
      </Box>
      <RowSegment flexShrink={0}>
        {`${row.call.label} · ${row.statusLabel}`}
      </RowSegment>
      <ApprovalSegments approval={approval} />
      {detail ? (
        <RowSegment
          color={
            row.detail?.kind === 'error'
              ? WORKFLOW_TASK_STATUS_COLOR.failed
              : undefined
          }
          dimColor={row.detail?.kind !== 'error'}
          flexShrink={1}
        >{`  ${detail}`}</RowSegment>
      ) : null}
    </Box>
  );
}

/** A plan task the run has not issued yet: label and status, nothing to
 *  focus, kill, or retry. */
export function DeclaredTaskRow({
  settled,
  task,
}: {
  readonly settled: boolean;
  readonly task: WorkflowCallIdentity;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text aria-hidden color={WORKFLOW_TASK_STATUS_COLOR.declared}>
          {markerCell(WORKFLOW_CALL_STATUS_GLYPH.declared)}
        </Text>
      </Box>
      <RowSegment dimColor flexShrink={0}>
        {`${task.label} · ${workflowPlanEntryLabel(settled)}`}
      </RowSegment>
    </Box>
  );
}

/** A counted group of quiet rows; Enter unfolds it in place. */
export function GroupRow({
  focused,
  row,
}: {
  readonly focused: boolean;
  readonly row: Extract<WorkflowPhaseRow, { kind: 'group' }>;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text aria-hidden dimColor>
          {markerCell(row.expanded ? '▾' : '▸')}
        </Text>
      </Box>
      <RowSegment dimColor={!focused} flexShrink={1}>
        {formatWorkflowRowGroup(row)}
      </RowSegment>
    </Box>
  );
}
