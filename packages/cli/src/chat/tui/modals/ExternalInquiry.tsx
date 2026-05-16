import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { ExternalInquiryPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';
import { BaseTextInput } from '../input/BaseTextInput';
import { KeyHints } from '../ui/KeyHints';

export interface ExternalInquiryProps {
  readonly payload: ExternalInquiryPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function ExternalInquiry(
  props: ExternalInquiryProps,
): React.JSX.Element {
  const [answer, setAnswer] = useState('');
  useInput((input, key) => {
    if (key.escape) {
      props.onDecide({
        accepted: false,
        userMessage: 'External inquiry skipped by user.',
      });
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'r') {
      const feedback = answer.trim();
      props.onDecide({
        accepted: false,
        userMessage:
          feedback.length > 0 ? feedback : 'External inquiry rejected by user.',
      });
    }
  });

  return (
    <Box
      borderStyle="single"
      borderColor="green"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="green">
        Agent asks:
      </Text>
      <Box marginY={1}>
        <Text>{props.payload.question}</Text>
      </Box>
      <Box>
        <Text>{'> '}</Text>
        <BaseTextInput
          value={answer}
          onChange={setAnswer}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (trimmed.length === 0) {
              props.onDecide({ accepted: false, userMessage: 'cancelled' });
            } else {
              props.onDecide({ accepted: true, userMessage: trimmed });
            }
          }}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Enter', action: 'submit answer' },
            { key: 'Ctrl-R', action: 'reject with note' },
            { key: 'Esc', action: 'skip' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
