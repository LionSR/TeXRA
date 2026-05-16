import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

import { buildHunks, DiffView, statsFromHunks } from '../render/DiffView';
import type { ApprovalDecision } from '../state/approvalQueue';
import { KeyHints } from '../ui/KeyHints';

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
    <Box
      borderStyle="double"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        Apply edit to {props.request.path}?
      </Text>
      <Text dimColor>
        +{stats.added} / −{stats.removed} · {stats.hunks} hunks · source:{' '}
        {props.request.sourceTool}
      </Text>
      <Box marginY={1} flexDirection="column">
        <DiffView hunks={hunks} maxHunkLines={30} />
      </Box>
      <Box>
        <ConfirmInput
          onConfirm={() => props.onDecide({ accepted: true })}
          onCancel={() => props.onDecide({ accepted: false })}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'y', action: 'approve' },
            { key: 'n', action: 'reject' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
