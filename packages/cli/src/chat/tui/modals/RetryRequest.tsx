import { Box, Text } from 'ink';

import {
  isCliApiSwitchableRetry,
  isCliChatGptSubscriptionRetry,
} from '@cli/runtime/approvalAdapter';
import type { RetryPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import { COLOR_HINT, COLOR_WARNING } from '../ui/colors';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface RetryRequestProps {
  readonly payload: RetryPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function RetryRequest(props: RetryRequestProps): React.JSX.Element {
  const subject = props.payload.errorMessage ?? props.payload.operation;
  const isChatGptSubscription = isCliChatGptSubscriptionRetry(props.payload);
  const canSwitchToPersonalKey = isCliApiSwitchableRetry(props.payload);
  // Both switches flip the api-mode to personal keys so the retry uses the
  // user's own key (not the relay JWT); the subscription switch additionally
  // turns off the "prefer ChatGPT subscription" preference.
  const switchDecision: ApprovalDecision = isChatGptSubscription
    ? { accepted: true, disableChatGptSubscription: true, apiMode: 'personal' }
    : { accepted: true, apiMode: 'personal' };
  const switchHint = isChatGptSubscription
    ? 'Press k to switch from your ChatGPT subscription to your OpenAI API key before retrying.'
    : 'Press k to switch to personal API keys before retrying.';
  return (
    <ConfirmCard
      borderStyle="single"
      color={COLOR_WARNING}
      title="Retry the failed call?"
      approveLabel="retry"
      rejectLabel="give up"
      rejectionMode="immediate"
      extraActions={
        canSwitchToPersonalKey
          ? [
              {
                key: 'k',
                label: 'use API key and retry',
                decision: switchDecision,
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
        <Text color={COLOR_HINT}>{switchHint}</Text>
      ) : null}
    </ConfirmCard>
  );
}
