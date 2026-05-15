import { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

import type { ExternalInquiryPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';

export interface ExternalInquiryProps {
  readonly payload: ExternalInquiryPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function ExternalInquiry(
  props: ExternalInquiryProps,
): React.JSX.Element {
  const p = props.payload as Record<string, unknown>;
  const question = typeof p.question === 'string' ? p.question : '(question)';
  const [answer, setAnswer] = useState('');

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
        <Text>{question}</Text>
      </Box>
      <Box>
        <Text>{'> '}</Text>
        <TextInput
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
    </Box>
  );
}
