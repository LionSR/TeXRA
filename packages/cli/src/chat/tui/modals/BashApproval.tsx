import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { BashPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';

export interface BashApprovalProps {
  readonly payload: BashPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function BashApproval(props: BashApprovalProps): React.JSX.Element {
  const command =
    'command' in props.payload && typeof props.payload.command === 'string'
      ? props.payload.command
      : '(unknown command)';

  return (
    <Box
      borderStyle="double"
      borderColor="yellow"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="yellow">
        Run bash command?
      </Text>
      <Box marginY={1}>
        <Text>$ {command}</Text>
      </Box>
      <Box>
        <Text dimColor>y approve · n reject · </Text>
        <ConfirmInput
          onConfirm={() => props.onDecide({ accepted: true })}
          onCancel={() => props.onDecide({ accepted: false })}
        />
      </Box>
    </Box>
  );
}
