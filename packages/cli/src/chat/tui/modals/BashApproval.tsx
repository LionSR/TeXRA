import { Text, useWindowSize } from 'ink';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { confirmCardContentWidth } from '@cli/tui/ui/theme';
import { truncateToWidth } from '@cli/runtime/terminalText';
import type { BashPermission } from '@shared/schemas';

import type { SurfaceDecision } from '@shared/session/approvalDecision';
import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';

interface BashApprovalProps {
  readonly availableRows?: number;
  readonly payload: BashPermission;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

const COMMAND_APPROVAL_TITLE = 'Run command?';

function bashCwdDisplayLine({
  cwd,
  width,
}: {
  readonly cwd?: string;
  readonly width: number;
}): string | undefined {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) return undefined;

  return truncateToWidth(`Directory: ${trimmedCwd}`, width);
}

export function BashApproval(props: BashApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const commandWidth = confirmCardContentWidth(columns);
  const cwdLine = bashCwdDisplayLine({
    cwd: props.payload.cwd,
    width: commandWidth,
  });
  const maxCommandRows = scrollableModalTextRowsBudget({
    availableRows: props.availableRows,
    columns,
    extraFixedRows: cwdLine ? 1 : 0,
    title: COMMAND_APPROVAL_TITLE,
  });

  return (
    <ConfirmCard
      borderStyle="double"
      color={COLOR_WARNING}
      title={COMMAND_APPROVAL_TITLE}
      rejectionMode="feedback"
      alwaysAllowLabel="approve commands for session"
      onDecide={props.onDecide}
    >
      {cwdLine && <Text dimColor>{cwdLine}</Text>}
      <ScrollableModalText
        firstLinePrefix="$ "
        continuationPrefix="  "
        marginWhenSpacious={!cwdLine}
        maxRows={maxCommandRows}
        scrollHint="scroll command"
        text={props.payload.command}
        width={commandWidth}
      />
    </ConfirmCard>
  );
}
