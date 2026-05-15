import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { RetryPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';

export interface RetryRequestProps {
  readonly payload: RetryPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function RetryRequest(props: RetryRequestProps): React.JSX.Element {
  const subject = props.payload.errorMessage ?? props.payload.operation;

  return (
    <Box
      borderStyle="single"
      borderColor="yellow"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="yellow">
        Retry the failed call?
      </Text>
      <Box marginY={1}>
        <Text dimColor>{subject}</Text>
      </Box>
      <Box>
        <Text dimColor>y retry · n give up · </Text>
        <ConfirmInput
          onConfirm={() => props.onDecide({ accepted: true })}
          onCancel={() => props.onDecide({ accepted: false })}
        />
      </Box>
    </Box>
  );
}
