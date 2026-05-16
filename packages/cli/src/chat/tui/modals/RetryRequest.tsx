import { Box, Text } from 'ink';

import type { RetryPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface RetryRequestProps {
  readonly payload: RetryPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function RetryRequest(props: RetryRequestProps): React.JSX.Element {
  const subject = props.payload.errorMessage ?? props.payload.operation;
  return (
    <ConfirmCard
      borderStyle="single"
      color="yellow"
      title="Retry the failed call?"
      approveLabel="retry"
      rejectLabel="give up"
      onDecide={props.onDecide}
    >
      <Box marginY={1}>
        <Text dimColor>{subject}</Text>
      </Box>
    </ConfirmCard>
  );
}
