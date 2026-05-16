import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { BashPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';
import { KeyHints } from '../ui/KeyHints';

export interface BashApprovalProps {
  readonly payload: BashPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function BashApproval(props: BashApprovalProps): React.JSX.Element {
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
        <Text>$ {props.payload.command}</Text>
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
            { key: 'y', action: 'approve' },
            { key: 'n', action: 'reject' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
