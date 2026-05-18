// Shared scaffolding for y/n approval modals — bordered frame, colored
// title, padded body slot, key handling, and KeyHints footer.

import { useState } from 'react';
import { Box, Text, type BoxProps } from 'ink';
import { useInput } from 'ink';

import { confirmCardKeyAction } from './ConfirmCardState';
import type {
  ApprovalBypassKind,
  ApprovalDecision,
} from '../state/approvalQueue';
import { BaseTextInput } from '../input/BaseTextInput';
import { KeyHints } from '../ui/KeyHints';

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
  readonly children: React.ReactNode;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function ConfirmCard({
  borderStyle,
  color,
  title,
  approveLabel = 'approve',
  rejectLabel = 'reject',
  alwaysAllow,
  children,
  onDecide,
}: ConfirmCardProps): React.JSX.Element {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState('');

  useInput(
    (input, key) => {
      if (feedbackMode) {
        if (key.escape) {
          setFeedbackMode(false);
          setFeedback('');
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
          setFeedbackMode(true);
          return;
        case 'ignore':
          return;
      }
    },
    { isActive: true },
  );

  const hints = [
    { key: 'y', action: approveLabel },
    { key: 'n', action: rejectLabel },
    ...(alwaysAllow ? [{ key: 'a', action: alwaysAllow.label }] : []),
    { key: 'e', action: 'reject with feedback' },
    { key: 'Esc', action: 'cancel' },
  ];

  return (
    <Box
      borderStyle={borderStyle}
      borderColor={color}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={color}>
        {title}
        {alwaysAllow ? <Text dimColor> · a = {alwaysAllow.label}</Text> : null}
      </Text>
      {children}
      {feedbackMode ? (
        <Box marginTop={1}>
          <Text>{'> '}</Text>
          <BaseTextInput
            value={feedback}
            onChange={setFeedback}
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
