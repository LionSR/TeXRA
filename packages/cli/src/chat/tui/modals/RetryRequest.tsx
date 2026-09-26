import { Text, useWindowSize } from 'ink';

import { wrappedRowCount } from '@cli/tui/ansiWrap';
import { COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import { confirmCardContentWidth } from '@cli/tui/ui/theme';
import type { SurfaceDecision } from '@shared/session/approvalDecision';
import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import { type RetryApprovalPayload } from '../state/approvalQueue';

interface RetryRequestProps {
  readonly availableRows?: number;
  readonly payload: RetryApprovalPayload;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

const RETRY_REQUEST_TITLE = 'Retry the failed call?';
const RETRY_REQUEST_HIDDEN_NOUN = 'error rows';

/** Wrapped row count of the guidance line, used to budget the error body. */
function retryGuidanceRows(
  guidance: string | undefined,
  width: number,
): number {
  if (!guidance) return 0;
  return wrappedRowCount(guidance, width);
}

export function RetryRequest(props: RetryRequestProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const { data } = props.payload;
  const errorText = data.errorMessage ?? data.operation;
  // The run decided the offer; the card only renders it. The Copilot move is
  // the editor's, so no run on this host carries it.
  const canSwitchToPersonalKey =
    data.credentialSwitch != null &&
    data.credentialSwitch.kind !== 'copilot-fallback';
  // The modal only names the answer. `y` retries on the credentials the run
  // already has; `approvalDecisionArms` turns a retry on personal credentials
  // into the host's `useOwnApiKey`, which asks for the key when none is
  // stored and then settles the retry on it.
  const retryDecision: SurfaceDecision = { action: 'retry' };
  const switchDecision: SurfaceDecision = {
    action: 'retry',
    credentials: 'personal',
  };
  const guidanceText = canSwitchToPersonalKey
    ? 'Press k to use your own API key for this retry.'
    : undefined;

  const contentWidth = confirmCardContentWidth(columns);
  // A provider stack trace can be arbitrarily tall. Budget the body the same
  // way the other approval cards do so the error scrolls instead of pushing
  // retry/stop run past the live region's clip.
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
      approveDecision={retryDecision}
      rejectLabel="stop run"
      rejectionMode="immediate"
      extraActions={
        canSwitchToPersonalKey
          ? [
              {
                key: 'k',
                action: 'retry with your own API key',
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
