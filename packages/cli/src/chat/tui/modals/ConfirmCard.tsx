// Shared scaffolding for y/n approval modals — bordered frame, colored
// title, padded body slot, key handling, and KeyHints footer.

import { createContext, useState } from 'react';
import { Box, Text, useInput, useWindowSize, type BoxProps } from 'ink';

import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import {
  KEY_HINT_SEPARATOR,
  KeyHints,
  keyHintSpans,
  type KeyHint,
} from '@cli/tui/ui/KeyHints';
import { POINTER } from '@cli/tui/ui/glyphs';
import { CONFIRM_CARD_HORIZONTAL_DECORATION } from '@cli/tui/ui/theme';
import { useLiveNowMs } from '@cli/tui/useLiveNowMs';
import type { SurfaceDecision } from '@shared/session/approvalDecision';
import {
  confirmCardCompactHintLayout,
  confirmCardFeedbackHints,
  confirmCardKeyDecision,
  confirmCardKeyHintsForWidth,
  confirmCardKeyRows,
  confirmCardPulsedTitle,
  type ConfirmCardHintOptions,
  type ConfirmCardKeyRow,
  type ConfirmCardRejectionMode,
} from './ConfirmCardState';
import { confirmCardFeedbackRows } from './confirmCardRowsBudget';
import { BaseTextInput } from '../input/BaseTextInput';

/** Rejection-note prompt for every ConfirmCard-based approval modal. */
const CONFIRM_CARD_FEEDBACK_PLACEHOLDER = 'Feedback to send with rejection';

/** The enclosing card's rejection note: `mode` is true while its input owns
 *  the keyboard (a scrollable body releases ↑/↓), and `rows` is what it takes
 *  from the body's row budget. The card is the one owner of this state. */
export const ConfirmCardFeedback = createContext({ mode: false, rows: 0 });

interface ConfirmCardProps extends ConfirmCardHintOptions<ConfirmCardKeyRow> {
  readonly borderStyle: BoxProps['borderStyle'];
  readonly color: string;
  readonly title: string;
  readonly rejectionMode: ConfirmCardRejectionMode;
  readonly feedbackPlaceholder?: string;
  readonly compact?: boolean;
  readonly children: React.ReactNode;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

export function ConfirmCard({
  borderStyle,
  color,
  title,
  feedbackPlaceholder = CONFIRM_CARD_FEEDBACK_PLACEHOLDER,
  compact = false,
  children,
  onDecide,
  ...keyOptions
}: ConfirmCardProps): React.JSX.Element {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState('');
  const { columns } = useWindowSize();
  // A pending approval always needs the user's eyes on it — pulse the title
  // at 1 Hz off the shared clock (same pattern as LoadingIndicator and the
  // status bar's running marker) instead of a static line, so it's harder to
  // miss.
  const now = useLiveNowMs(true);
  const pulsedTitle = confirmCardPulsedTitle(now, title);
  const keyRows = confirmCardKeyRows(keyOptions);

  function feedbackInput(marginTop: number): React.JSX.Element {
    return (
      <Box marginTop={marginTop}>
        <Text>{`${POINTER} `}</Text>
        <BaseTextInput
          value={feedback}
          placeholder={feedbackPlaceholder}
          onChange={setFeedback}
          onEscape={() => {
            setFeedbackMode(false);
            setFeedback('');
          }}
          onSubmit={(value) =>
            onDecide({ action: 'reject', feedback: value.trim() })
          }
        />
      </Box>
    );
  }

  useInput(
    (input, key) => {
      const decision = confirmCardKeyDecision(input, key, keyRows);
      if (decision === 'feedback') setFeedbackMode(true);
      else if (decision) onDecide(decision);
    },
    { isActive: !feedbackMode },
  );

  const compactHintLayout =
    compact && !feedbackMode
      ? confirmCardCompactHintLayout({ ...keyOptions, title, columns })
      : undefined;
  let hints: readonly KeyHint[];
  if (feedbackMode) {
    hints = confirmCardFeedbackHints();
  } else if (compact) {
    hints = compactHintLayout?.inlineHints ?? [];
  } else {
    hints = confirmCardKeyHintsForWidth({
      ...keyOptions,
      maxColumns: Math.max(0, columns - CONFIRM_CARD_HORIZONTAL_DECORATION),
    });
  }
  const stackedCompactHints = compactHintLayout?.stackedHints ?? hints;
  const stackCompactHints = compactHintLayout?.stack ?? false;

  const feedbackState = {
    mode: feedbackMode,
    rows: feedbackMode
      ? confirmCardFeedbackRows({
          columns,
          placeholder: feedbackPlaceholder,
          value: feedback,
        })
      : 0,
  };
  // Compact cards swap the body out for the feedback input.
  return (
    <ConfirmCardFeedback value={feedbackState}>
      {compact ? (
        <Box flexDirection="column">
          {stackCompactHints ? (
            <>
              <Text bold color={color} wrap="truncate-end">
                {pulsedTitle}
              </Text>
              <KeyHints hints={stackedCompactHints} confirmCancel={false} />
            </>
          ) : (
            <Text bold color={color} wrap="truncate-end">
              {pulsedTitle}
              <Text dimColor>{KEY_HINT_SEPARATOR}</Text>
              <Text dimColor>{keyHintSpans(hints)}</Text>
            </Text>
          )}
          {feedbackMode ? feedbackInput(0) : children}
        </Box>
      ) : (
        <BorderedPanel
          borderStyle={borderStyle}
          color={color}
          title={pulsedTitle}
          footer={<KeyHints hints={hints} confirmCancel={false} />}
        >
          {children}
          {feedbackMode ? feedbackInput(1) : null}
        </BorderedPanel>
      )}
    </ConfirmCardFeedback>
  );
}
