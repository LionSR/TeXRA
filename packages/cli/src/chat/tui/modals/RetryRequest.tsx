import { Box, Text } from 'ink';

import { isCliApiSwitchableRetry } from '@cli/runtime/approvalAdapter';
import type { RetryPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface RetryRequestProps {
  readonly payload: RetryPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function RetryRequest(props: RetryRequestProps): React.JSX.Element {
  const subject = props.payload.errorMessage ?? props.payload.operation;
  const canSwitchToPersonalKey = isCliApiSwitchableRetry(props.payload);
  return (
    <ConfirmCard
      borderStyle="single"
      color="yellow"
      title="Retry the failed call?"
      approveLabel="retry"
      rejectLabel="give up"
      extraActions={
        canSwitchToPersonalKey
          ? [
              {
                key: 'k',
                label: 'use API key and retry',
                decision: { accepted: true, apiMode: 'personal' },
              },
            ]
          : []
      }
      onDecide={props.onDecide}
    >
      <Box marginY={1}>
        <Text dimColor>{subject}</Text>
      </Box>
      {canSwitchToPersonalKey ? (
        <Text color="cyan">
          Press k to switch to personal API keys before retrying.
        </Text>
      ) : null}
    </ConfirmCard>
  );
}
