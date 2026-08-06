import { Box, Text } from 'ink';

import {
  isCliApiSwitchableRetry,
  isCliChatGptSubscriptionRetry,
} from '@cli/runtime/approval/approvalPrompts';
import { COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import { missingApiKeyRetryMessage } from '@cli/tui/ui/retryCopy';
import { isApiProvider } from '@model/apiProviders';
import { ConfirmCard } from './ConfirmCard';
import {
  type ApprovalDecision,
  type TuiRetryRequest,
} from '../state/approvalQueue';

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
  let keyGuidance: React.JSX.Element | null = null;
  if (
    isCliApiSwitchableRetry(props.payload) &&
    personalApiKeyAvailable !== true
  ) {
    const requestedProvider = props.payload.errorDetails?.provider;
    const provider =
      requestedProvider && isApiProvider(requestedProvider)
        ? requestedProvider
        : undefined;
    keyGuidance = (
      <Text color={COLOR_HINT}>
        {props.payload.missingPersonalApiKeyMessage ??
          missingApiKeyRetryMessage(provider)}
      </Text>
    );
  } else if (canSwitchToPersonalKey) {
    keyGuidance = (
      <Text color={COLOR_HINT}>
        Press k to use your own API key for this retry.
      </Text>
    );
  }
  return (
    <ConfirmCard
      borderStyle="single"
      color={COLOR_WARNING}
      title="Retry the failed call?"
      approveLabel="retry"
      rejectLabel="dismiss"
      rejectionMode="immediate"
      extraActions={
        canSwitchToPersonalKey
          ? [
              {
                key: 'k',
                label: 'retry with your own API key',
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
