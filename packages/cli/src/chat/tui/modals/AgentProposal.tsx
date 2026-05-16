import { Box, Text } from 'ink';

import type { AgentProposalPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface AgentProposalProps {
  readonly payload: AgentProposalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function AgentProposal(props: AgentProposalProps): React.JSX.Element {
  return (
    <ConfirmCard
      borderStyle="double"
      color="magenta"
      title={`Spawn ${props.payload.agent}?`}
      onDecide={props.onDecide}
    >
      <Box marginY={1}>
        <Text>{props.payload.instruction}</Text>
      </Box>
    </ConfirmCard>
  );
}
