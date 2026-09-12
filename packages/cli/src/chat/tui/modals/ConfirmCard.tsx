// Shared scaffolding for y/n approval modals — bordered frame, colored
// title, padded body slot, key handling, and KeyHints footer.

import { useState } from 'react';
import { Box, Text, useInput, useWindowSize, type BoxProps } from 'ink';

import { isEscapeInput } from '@cli/tui/inputKeys';
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
import {
  APPROVE_SESSION_ACTION,
  type SurfaceDecision,
} from '@shared/session/approvalDecision';
import {
  confirmCardCompactHintLayout,
  confirmCardFeedbackHints,
  confirmCardKeyAction,
  confirmCardKeyHintsForWidth,
  confirmCardPulsedTitle,
  type ConfirmCardRejectionMode,
} from './ConfirmCardState';
import { BaseTextInput } from '../input/BaseTextInput';

/** Rejection-note prompt for every ConfirmCard-based approval modal. */
export const CONFIRM_CARD_FEEDBACK_PLACEHOLDER =
  'Feedback to send with rejection';

/** What the approve key answers with unless a card names its own. */
const PLAIN_APPROVE: SurfaceDecision = { action: 'approve' };

interface ConfirmCardProps {
  readonly borderStyle: BoxProps['borderStyle'];
  readonly color: string;
  readonly title: string;
  /** Omitted labels are resolved by `confirmCardKeyHints`. */
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
  readonly rejectionMode: ConfirmCardRejectionMode;
  /**
   * What the approve key answers with, for a request a plain approve does not
   * answer: the retry card's `y` is `{ action: 'retry' }`, because a retry
   * request reads its consent off that arm and nothing else. Defaults to a
   * plain approve.
   */
  readonly approveDecision?: SurfaceDecision;
  /** Label of the `a` session-bypass action; omitted where the request kind
   *  offers none. */
  readonly alwaysAllowLabel?: string;
  readonly extraActions?: readonly {
    readonly key: string;
    readonly label: string;
    readonly decision: SurfaceDecision;
  }[];
  readonly feedbackPlaceholder?: string;
  readonly compact?: boolean;
  readonly onFeedbackModeChange?: (active: boolean) => void;
  readonly onFeedbackValueChange?: (value: string) => void;
  readonly children: React.ReactNode;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

export function ConfirmCard({
  borderStyle,
  color,
  title,
  approveLabel,
  rejectLabel,
  rejectionMode,
  approveDecision = PLAIN_APPROVE,
  alwaysAllowLabel,
  extraActions = [],
  feedbackPlaceholder = CONFIRM_CARD_FEEDBACK_PLACEHOLDER,
  compact = false,
  onFeedbackModeChange,
  onFeedbackValueChange,
  children,
  onDecide,
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

  function setFeedbackActive(active: boolean): void {
    setFeedbackMode(active);
    onFeedbackModeChange?.(active);
  }

  function updateFeedback(value: string): void {
    setFeedback(value);
    onFeedbackValueChange?.(value);
  }

  function feedbackInput(marginTop: number): React.JSX.Element {
    return (
      <Box marginTop={marginTop}>
        <Text>{`${POINTER} `}</Text>
        <BaseTextInput
          value={feedback}
          placeholder={feedbackPlaceholder}
          onChange={updateFeedback}
          onSubmit={(value) =>
            onDecide({ action: 'reject', feedback: value.trim() })
          }
        />
      </Box>
    );
  }

  useInput(
    (input, key) => {
      if (feedbackMode) {
        if (isEscapeInput(input, key)) {
          setFeedbackActive(false);
          updateFeedback('');
        }
        return;
      }
      switch (
        confirmCardKeyAction(input, key, {
          allowAlways: alwaysAllowLabel != null,
          rejectionMode,
        })
      ) {
        case 'approve':
          onDecide(approveDecision);
          return;
        case 'reject':
          onDecide({ action: 'reject' });
          return;
        case 'approveAlways':
          if (alwaysAllowLabel != null) {
            // Surface-only (ruling A9-6): `approvalDecisionArms` decomposes
            // it into the request's own session bypass plus a plain approve.
            onDecide({ action: APPROVE_SESSION_ACTION });
          }
          return;
        case 'feedback':
          setFeedbackActive(true);
          return;
        case 'ignore':
          if (key.ctrl || key.meta) return;
          for (const action of extraActions) {
            if (input.toLowerCase() === action.key.toLowerCase()) {
              onDecide(action.decision);
              return;
            }
          }
          return;
      }
    },
    { isActive: true },
  );

  const mappedExtraActions = extraActions.map((action) => ({
    key: action.key,
    action: action.label,
  }));
  const compactHintLayout =
    compact && !feedbackMode
      ? confirmCardCompactHintLayout({
          title,
          approveLabel,
          rejectLabel,
          rejectionMode,
          alwaysAllowLabel,
          extraActions: mappedExtraActions,
          columns,
        })
      : undefined;
  let hints: readonly KeyHint[];
  if (feedbackMode) {
    hints = confirmCardFeedbackHints();
  } else if (compact) {
    hints = compactHintLayout?.inlineHints ?? [];
  } else {
    hints = confirmCardKeyHintsForWidth({
      approveLabel,
      rejectLabel,
      rejectionMode,
      alwaysAllowLabel,
      extraActions: mappedExtraActions,
      maxColumns: Math.max(0, columns - CONFIRM_CARD_HORIZONTAL_DECORATION),
    });
  }
  const stackedCompactHints = compactHintLayout?.stackedHints ?? hints;
  const stackCompactHints = compactHintLayout?.stack ?? false;

  if (compact) {
    return (
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
    );
  }

  return (
    <BorderedPanel
      borderStyle={borderStyle}
      color={color}
      title={pulsedTitle}
      footer={<KeyHints hints={hints} confirmCancel={false} />}
    >
      {children}
      {feedbackMode ? feedbackInput(1) : null}
    </BorderedPanel>
  );
}
