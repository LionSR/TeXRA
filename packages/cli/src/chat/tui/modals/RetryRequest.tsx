import { Text, useWindowSize } from 'ink';

import { wrappedRowCount } from '@cli/tui/ansiWrap';
import { COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import { confirmCardContentWidth } from '@cli/tui/ui/theme';
import {
  REQUEST_ACTIONS,
  type SurfaceDecision,
} from '@texra/shared/session/surfaceDecision';
import { modelFailureText } from '@ui/copy/modelAccess';
import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import { type RetryTuiRequest } from '../state/approvalQueue';

interface RetryRequestProps {
  readonly availableRows?: number;
  readonly payload: RetryTuiRequest;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

const RETRY_REQUEST_TITLE = 'Retry the failed call?';
const RETRY_REQUEST_HIDDEN_NOUN = 'error rows';

export function RetryRequest(props: RetryRequestProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const { data } = props.payload;
  const errorText = modelFailureText(data.failure);
  // The run decided the offer; the card only renders it.
  const canSwitchToPersonalKey = data.credentialSwitch != null;
  // The modal only names the answers, as `REQUEST_ACTIONS` keys them. `y`
  // retries on the credentials the run already has; `approvalDecisionArm`
  // turns `k`, a retry on personal credentials, into the host's
  // `useOwnApiKey`, which asks for the key when none is stored and then runs
  // the retry on it.
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
    extraFixedRows: guidanceText
      ? wrappedRowCount(guidanceText, contentWidth)
      : 0,
    title: RETRY_REQUEST_TITLE,
  });

  return (
    <ConfirmCard
      color={COLOR_WARNING}
      title={RETRY_REQUEST_TITLE}
      kind="retry"
      approveLabel="retry"
      rejectLabel="stop run"
      extraActions={
        canSwitchToPersonalKey
          ? [
              {
                key: 'k',
                action: 'retry with your own API key',
                decision: REQUEST_ACTIONS.retry.k,
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
