import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { RetryPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';
import { KeyHints } from '../ui/KeyHints';

export interface RetryRequestProps {
  readonly payload: RetryPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function RetryRequest(props: RetryRequestProps): React.JSX.Element {
  const subject = props.payload.errorMessage ?? props.payload.operation;

  return (
    <Box
      borderStyle="single"
      borderColor="yellow"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="yellow">
        Retry the failed call?
      </Text>
      <Box marginY={1}>
        <Text dimColor>{subject}</Text>
      </Box>
      <Box>
        <ConfirmInput
          onConfirm={() => props.onDecide({ accepted: true })}
          onCancel={() => props.onDecide({ accepted: false })}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'y', action: 'retry' },
            { key: 'n', action: 'give up' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
