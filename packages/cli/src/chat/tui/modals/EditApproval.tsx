import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

import { DiffView, diffStats } from '../render/DiffView';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface EditApprovalProps {
  readonly request: ToolEditApprovalRequest;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function EditApproval(props: EditApprovalProps): React.JSX.Element {
  const stats = diffStats(
    props.request.originalContent ?? '',
    props.request.proposedContent ?? '',
  );

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
        <DiffView
          fileLabel={props.request.path}
          originalContent={props.request.originalContent ?? ''}
          proposedContent={props.request.proposedContent ?? ''}
          maxHunkLines={30}
        />
      </Box>
      <Box>
        <Text dimColor>y approve · n reject · </Text>
        <ConfirmInput
          onConfirm={() => props.onDecide({ accepted: true })}
          onCancel={() => props.onDecide({ accepted: false })}
        />
      </Box>
    </Box>
  );
}
