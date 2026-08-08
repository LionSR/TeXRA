import { Text, useWindowSize } from 'ink';

import {
  isCliApiSwitchableRetry,
  isCliChatGptSubscriptionRetry,
  isCliCodingPlanRetry,
} from '@cli/runtime/approval/approvalPrompts';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import { missingApiKeyRetryMessage } from '@cli/tui/ui/retryCopy';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
} from '@cli/tui/ui/theme';
import { isApiProvider } from '@model/apiProviders';
import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import {
  type ApprovalDecision,
  type TuiRetryRequest,
} from '../state/approvalQueue';

export interface RetryRequestProps {
  readonly availableRows?: number;
  readonly payload: TuiRetryRequest;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

const RETRY_REQUEST_TITLE = 'Retry the failed call?';
const RETRY_REQUEST_HIDDEN_NOUN = 'error rows';

/** Wrapped row count of the guidance line, used to budget the error body. */
function retryGuidanceRows(
  guidance: string | undefined,
  width: number,
): number {
  if (!guidance) return 0;
  return Math.max(
    1,
    wrapAnsiToWidth(guidance, Math.max(1, width)).split('\n').length,
  );
}

export function RetryRequest(props: RetryRequestProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const errorText = props.payload.errorMessage ?? props.payload.operation;
  const isSubscriptionLimit = isCliChatGptSubscriptionRetry(props.payload);
  const isGlmCodingPlanLimit = isCliCodingPlanRetry(props.payload);
  const isApiSwitchable = isCliApiSwitchableRetry(props.payload);
  const personalApiKeyAvailable = props.payload.personalApiKeyAvailable;
  const canSwitchToPersonalKey =
    isApiSwitchable && personalApiKeyAvailable === true;
  // Both switches flip the api-mode to personal keys so the retry uses the
  // user's own key (not the relay JWT); the subscription switches additionally
  // turn off the "prefer ChatGPT subscription" / coding-plan preference.
  const exhaustionReason = props.payload.errorDetails?.exhaustionReason;
  let switchDecision: ApprovalDecision;
  if (isSubscriptionLimit) {
    switchDecision = {
      accepted: true,
      disableChatGptSubscription: true,
      apiMode: 'personal',
    };
  } else if (exhaustionReason === 'glm-coding-plan') {
    switchDecision = {
      accepted: true,
      disableGlmCodingPlan: true,
      apiMode: 'personal',
    };
  } else if (isGlmCodingPlanLimit) {
    switchDecision = {
      accepted: true,
      disableKimiCode: true,
      apiMode: 'personal',
    };
  } else {
    switchDecision = { accepted: true, apiMode: 'personal' };
  }
  let guidanceText: string | undefined;
  if (isApiSwitchable && personalApiKeyAvailable !== true) {
    const requestedProvider = props.payload.errorDetails?.provider;
    const provider =
      requestedProvider && isApiProvider(requestedProvider)
        ? requestedProvider
        : undefined;
    guidanceText =
      props.payload.missingPersonalApiKeyMessage ??
      missingApiKeyRetryMessage(provider);
  } else if (canSwitchToPersonalKey) {
    guidanceText = 'Press k to use your own API key for this retry.';
  }

  const contentWidth = clampModalWidth(
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  // A provider stack trace can be arbitrarily tall. Budget the body the same
  // way the other approval cards do so the error scrolls instead of pushing
  // retry/dismiss past the live region's clip.
  const maxSubjectRows = scrollableModalTextRowsBudget({
    availableRows: props.availableRows,
    columns,
    extraFixedRows: retryGuidanceRows(guidanceText, contentWidth),
    title: RETRY_REQUEST_TITLE,
  });

  return (
    <ConfirmCard
      borderStyle="single"
      color={COLOR_WARNING}
      title={RETRY_REQUEST_TITLE}
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
      <ScrollableModalText
        hiddenNoun={RETRY_REQUEST_HIDDEN_NOUN}
        maxRows={maxSubjectRows}
        scrollHint="scroll error"
        text={errorText}
        trimWrappedLeadingWhitespace
        width={contentWidth}
      />
      {guidanceText ? <Text color={COLOR_HINT}>{guidanceText}</Text> : null}
    </ConfirmCard>
  );
}
