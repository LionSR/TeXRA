import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { AgentProposalPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';

export interface AgentProposalProps {
  readonly payload: AgentProposalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function AgentProposal(props: AgentProposalProps): React.JSX.Element {
  return (
    <Box
      borderStyle="double"
      borderColor="magenta"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="magenta">
        Spawn {props.payload.agent}?
      </Text>
      <Box marginY={1}>
        <Text>{props.payload.instruction}</Text>
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
