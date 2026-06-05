// Shared scaffolding for y/n approval modals — bordered frame, colored
// title, padded body slot, key handling, and KeyHints footer.

import { useState } from 'react';
import { Box, Text, useWindowSize, type BoxProps } from 'ink';
import { useInput } from 'ink';

import {
  confirmCardFeedbackHints,
  confirmCardKeyAction,
  confirmCardKeyHintsForWidth,
} from './ConfirmCardState';
import { BaseTextInput } from '../input/BaseTextInput';
import { isEscapeInput } from '../input/inputKeys';
import { KEY_HINT_SEPARATOR, KeyHints } from '../ui/KeyHints';
import type {
  ApprovalBypassKind,
  ApprovalDecision,
} from '../state/approvalQueue';

export interface ConfirmCardProps {
  readonly borderStyle: BoxProps['borderStyle'];
  readonly color: string;
  readonly title: string;
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
  readonly alwaysAllow?: {
    readonly kind: ApprovalBypassKind;
    readonly label: string;
  };
  readonly extraActions?: readonly {
    readonly key: string;
    readonly label: string;
    readonly decision: ApprovalDecision;
  }[];
  readonly feedbackPlaceholder?: string;
  readonly compact?: boolean;
  readonly onFeedbackModeChange?: (active: boolean) => void;
  readonly onFeedbackValueChange?: (value: string) => void;
  readonly children: React.ReactNode;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export const CONFIRM_CARD_HORIZONTAL_DECORATION = 4;

export function ConfirmCard({
  borderStyle,
  color,
  title,
  approveLabel = 'approve',
  rejectLabel = 'reject',
  alwaysAllow,
  extraActions = [],
  feedbackPlaceholder = 'Feedback to send with rejection',
  compact = false,
  onFeedbackModeChange,
  onFeedbackValueChange,
  children,
  onDecide,
}: ConfirmCardProps): React.JSX.Element {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState('');
  const { columns } = useWindowSize();

  function setFeedbackActive(active: boolean): void {
    setFeedbackMode(active);
    onFeedbackModeChange?.(active);
  }

  function updateFeedback(value: string): void {
    setFeedback(value);
    onFeedbackValueChange?.(value);
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
      switch (confirmCardKeyAction(input, key, Boolean(alwaysAllow))) {
        case 'approve':
          onDecide({ accepted: true });
          return;
        case 'reject':
          onDecide({ accepted: false });
          return;
        case 'approveAlways':
          if (alwaysAllow) {
            onDecide({ accepted: true, bypass: alwaysAllow.kind });
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
  const hints = feedbackMode
    ? confirmCardFeedbackHints()
    : confirmCardKeyHintsForWidth({
        approveLabel,
        rejectLabel,
        alwaysAllowLabel: alwaysAllow?.label,
        extraActions: mappedExtraActions,
        maxColumns: Math.max(
          0,
          columns -
            (compact
              ? title.length + KEY_HINT_SEPARATOR.length
              : CONFIRM_CARD_HORIZONTAL_DECORATION),
        ),
      });
  const stackedCompactHints = feedbackMode
    ? hints
    : confirmCardKeyHintsForWidth({
        approveLabel,
        rejectLabel,
        alwaysAllowLabel: alwaysAllow?.label,
        extraActions: mappedExtraActions,
        maxColumns: columns,
      });
  const stackCompactHints =
    compact &&
    !feedbackMode &&
    hints.some((hint) => hint.key === 'Esc') &&
    stackedCompactHints.length > hints.length;

  if (compact) {
    return (
      <Box flexDirection="column">
        {stackCompactHints ? (
          <>
            <Text bold color={color} wrap="truncate-end">
              {title}
            </Text>
            <KeyHints hints={stackedCompactHints} confirmCancel={false} />
          </>
        ) : (
          <Text bold color={color} wrap="truncate-end">
            {title}
            <Text dimColor>{KEY_HINT_SEPARATOR}</Text>
            <Text dimColor>
              {hints.map((hint, index) => (
                <Text key={`${hint.key}-${hint.action}-${index}`}>
                  {index > 0 ? KEY_HINT_SEPARATOR : ''}
                  <Text bold>{hint.key}</Text> {hint.action}
                </Text>
              ))}
            </Text>
          </Text>
        )}
        {feedbackMode ? (
          <Box>
            <Text>{'> '}</Text>
            <BaseTextInput
              value={feedback}
              placeholder={feedbackPlaceholder}
              onChange={updateFeedback}
              onSubmit={(value) =>
                onDecide({ accepted: false, userMessage: value.trim() })
              }
            />
          </Box>
        ) : (
          children
        )}
      </Box>
    );
  }

  return (
    <Box
      borderStyle={borderStyle}
      borderColor={color}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={color}>
        {title}
      </Text>
      {children}
      {feedbackMode ? (
        <Box marginTop={1}>
          <Text>{'> '}</Text>
          <BaseTextInput
            value={feedback}
            placeholder={feedbackPlaceholder}
            onChange={updateFeedback}
            onSubmit={(value) =>
              onDecide({ accepted: false, userMessage: value.trim() })
            }
          />
        </Box>
      ) : null}
      <Box marginTop={1}>
        <KeyHints hints={hints} confirmCancel={false} />
      </Box>
    </Box>
  );
}
