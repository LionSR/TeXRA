import { useMemo } from 'react';
import { Box, Text } from 'ink';

import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

import { ConfirmCard } from './ConfirmCard';
import { buildHunks, DiffView, statsFromHunks } from '../render/DiffView';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface EditApprovalProps {
  readonly request: ToolEditApprovalRequest;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function EditApproval(props: EditApprovalProps): React.JSX.Element {
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
      onDecide={props.onDecide}
    >
      <Text dimColor>
        +{stats.added} / −{stats.removed} · {stats.hunks} hunks · source:{' '}
        {props.request.sourceTool}
      </Text>
      <Box marginY={1} flexDirection="column">
        <DiffView hunks={hunks} maxHunkLines={30} />
      </Box>
    </ConfirmCard>
  );
}
