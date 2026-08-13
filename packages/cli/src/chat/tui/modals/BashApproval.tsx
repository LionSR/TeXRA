import { useMemo, useState } from 'react';
import { Text, useWindowSize } from 'ink';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
} from '@cli/tui/ui/theme';
import { truncateToWidth } from '@cli/runtime/terminalText';
import type { BashPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface BashApprovalProps {
  readonly availableRows?: number;
  readonly payload: BashPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

const COMMAND_APPROVAL_TITLE = 'Run command?';

export function bashCwdDisplayLine({
  cwd,
  width,
}: {
  readonly cwd?: string;
  readonly width: number;
}): string | undefined {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) return undefined;

  return truncateToWidth(`Directory: ${trimmedCwd}`, clampModalWidth(width));
}

export function BashApproval(props: BashApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [feedbackMode, setFeedbackMode] = useState(false);
  const commandWidth = clampModalWidth(
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const cwdLine = useMemo(
    () => bashCwdDisplayLine({ cwd: props.payload.cwd, width: commandWidth }),
    [commandWidth, props.payload.cwd],
  );
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
      alwaysAllow={{ kind: 'bash', label: 'approve commands for session' }}
      onFeedbackModeChange={setFeedbackMode}
      onDecide={props.onDecide}
    >
      {cwdLine ? <Text dimColor>{cwdLine}</Text> : null}
      <ScrollableModalText
        firstLinePrefix="$ "
        continuationPrefix="  "
        marginWhenSpacious={!cwdLine}
        maxRows={maxCommandRows}
        scrollActive={!feedbackMode}
        scrollHint="scroll command"
        text={props.payload.command}
        width={commandWidth}
      />
    </ConfirmCard>
  );
}
