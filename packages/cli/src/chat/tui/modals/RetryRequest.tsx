import { Box, Text } from 'ink';

import {
  isCliApiSwitchableRetry,
  isCliChatGptSubscriptionRetry,
} from '@cli/runtime/approvalAdapter';
import { ConfirmCard } from './ConfirmCard';
import { COLOR_HINT, COLOR_WARNING } from '../ui/colors';
import {
  type ApprovalDecision,
  type TuiRetryRequest,
} from '../state/approvalQueue';
import { missingApiKeyRetryMessage } from '../ui/retryCopy';

export interface RetryRequestProps {
  readonly payload: TuiRetryRequest;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function RetryRequest(props: RetryRequestProps): React.JSX.Element {
  const subject = props.payload.errorMessage ?? props.payload.operation;
  const isChatGptSubscription = isCliChatGptSubscriptionRetry(props.payload);
  const personalApiKeyAvailable = props.payload.personalApiKeyAvailable;
  const canSwitchToPersonalKey =
    isCliApiSwitchableRetry(props.payload) && personalApiKeyAvailable === true;
  // Both switches flip the api-mode to personal keys so the retry uses the
  // user's own key (not the relay JWT); the subscription switch additionally
  // turns off the "prefer ChatGPT subscription" preference.
  const switchDecision: ApprovalDecision = isChatGptSubscription
    ? { accepted: true, disableChatGptSubscription: true, apiMode: 'personal' }
    : { accepted: true, apiMode: 'personal' };
  const switchHint = isChatGptSubscription
    ? 'Press k to switch from your ChatGPT subscription to your OpenAI API key before retrying.'
    : 'Press k to switch to personal API keys before retrying.';
  let keyGuidance: React.JSX.Element | null = null;
  if (
    isCliApiSwitchableRetry(props.payload) &&
    personalApiKeyAvailable !== true
  ) {
    keyGuidance = (
      <Text color={COLOR_HINT}>
        {props.payload.missingPersonalApiKeyMessage ??
          missingApiKeyRetryMessage('openai')}
      </Text>
    );
  } else if (canSwitchToPersonalKey) {
    keyGuidance = <Text color={COLOR_HINT}>{switchHint}</Text>;
  }
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
      {keyGuidance}
    </ConfirmCard>
  );
}
