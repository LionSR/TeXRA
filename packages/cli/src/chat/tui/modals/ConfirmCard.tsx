// Shared scaffolding for y/n approval modals — bordered frame, colored
// title, padded body slot, ConfirmInput, and `y / n` KeyHints footer.

import { Box, Text, type BoxProps } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { ApprovalDecision } from '../state/approvalQueue';
import { KeyHints } from '../ui/KeyHints';

export interface ConfirmCardProps {
  readonly borderStyle: BoxProps['borderStyle'];
  readonly color: string;
  readonly title: string;
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
  readonly children: React.ReactNode;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function ConfirmCard({
  borderStyle,
  color,
  title,
  approveLabel = 'approve',
  rejectLabel = 'reject',
  children,
  onDecide,
}: ConfirmCardProps): React.JSX.Element {
  return (
    <Box
      borderStyle={borderStyle}
      borderColor={color}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={color}>
        {title}
      </Text>
      {children}
      <Box>
        <ConfirmInput
          onConfirm={() => onDecide({ accepted: true })}
          onCancel={() => onDecide({ accepted: false })}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'y', action: approveLabel },
            { key: 'n', action: rejectLabel },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
