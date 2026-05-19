import { useMemo } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

import { ConfirmCard } from './ConfirmCard';
import { buildHunks, DiffView, statsFromHunks } from '../render/DiffView';
import type { ApprovalDecision } from '../state/approvalQueue';

const EDIT_DIFF_PADDING = 6;
const EDIT_APPROVAL_FIXED_ROWS = 8;
const MIN_EDIT_DIFF_WIDTH = 20;

export interface EditApprovalProps {
  readonly availableRows?: number;
  readonly request: ToolEditApprovalRequest;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function EditApproval(props: EditApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const diffWidth = Math.max(MIN_EDIT_DIFF_WIDTH, columns - EDIT_DIFF_PADDING);
  const maxDiffLines =
    props.availableRows === undefined
      ? 30
      : Math.max(1, props.availableRows - EDIT_APPROVAL_FIXED_ROWS);

  // Single diff pass shared between the summary line and the inline view.
  const hunks = useMemo(
    () =>
      buildHunks(
        props.request.path,
        props.request.originalContent,
        props.request.proposedContent,
      ),
    [
      props.request.path,
      props.request.originalContent,
      props.request.proposedContent,
    ],
  );
  const stats = useMemo(() => statsFromHunks(hunks), [hunks]);

  return (
    <ConfirmCard
      borderStyle="double"
      color="cyan"
      title={`Apply edit to ${props.request.path}?`}
      alwaysAllow={{ kind: 'toolEdit', label: 'approve edits this session' }}
      onDecide={props.onDecide}
    >
      <Text dimColor>
        +{stats.added} / −{stats.removed} · {stats.hunks} hunks · source:{' '}
        {props.request.sourceTool}
      </Text>
      <Box marginY={1} flexDirection="column">
        <DiffView
          hunks={hunks}
          maxDisplayLines={maxDiffLines}
          maxHunkLines={30}
          width={diffWidth}
        />
      </Box>
    </ConfirmCard>
  );
}
