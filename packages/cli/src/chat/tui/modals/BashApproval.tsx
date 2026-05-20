import { Box, Text } from 'ink';

import type { BashPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface BashApprovalProps {
  readonly payload: BashPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function BashApproval(props: BashApprovalProps): React.JSX.Element {
  return (
    <ConfirmCard
      borderStyle="double"
      color="yellow"
      title="Run bash command?"
      alwaysAllow={{ kind: 'toolEdit', label: 'approve session' }}
      onDecide={props.onDecide}
    >
      <Box marginY={1}>
        <Text>$ {props.payload.command}</Text>
      </Box>
    </ConfirmCard>
  );
}
