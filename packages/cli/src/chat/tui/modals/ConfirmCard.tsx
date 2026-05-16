// Shared scaffolding for y/n approval modals — bordered frame, colored
// title, padded body slot, ConfirmInput, and `y / n` KeyHints footer.

import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { ApprovalDecision } from '../state/approvalQueue';
import { KeyHints } from '../ui/KeyHints';

export interface ConfirmCardProps {
  readonly borderStyle: 'single' | 'double';
  readonly color: string;
  readonly title: string;
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
  readonly children: React.ReactNode;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function ConfirmCard(props: ConfirmCardProps): React.JSX.Element {
  return (
    <Box
      borderStyle={props.borderStyle}
      borderColor={props.color}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={props.color}>
        {props.title}
      </Text>
      {props.children}
      <Box>
        <ConfirmInput
          onConfirm={() => props.onDecide({ accepted: true })}
          onCancel={() => props.onDecide({ accepted: false })}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'y', action: props.approveLabel ?? 'approve' },
            { key: 'n', action: props.rejectLabel ?? 'reject' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
