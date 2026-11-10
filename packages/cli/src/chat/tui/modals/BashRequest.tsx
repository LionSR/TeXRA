import { Text, useWindowSize } from 'ink';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { confirmCardContentWidth } from '@cli/tui/ui/theme';
import { truncateToWidth } from '@cli/runtime/terminal/terminalText';

import type { SurfaceDecision } from '@texra/shared/session/surfaceDecision';
import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import type {
  ApprovalBypassKind,
  RequestPayload,
} from '@texra-ai/harness/schemas';

interface BashRequestProps {
  readonly availableRows?: number;
  readonly payload: Extract<RequestPayload, { kind: 'bash' }>['data'];
  /** The run grant the request offers (`offeredGrant`). */
  readonly grant: ApprovalBypassKind | null;
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

export function BashRequest(props: BashRequestProps): React.JSX.Element {
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
      color={COLOR_WARNING}
      title={COMMAND_APPROVAL_TITLE}
      kind="bash"
      grant={props.grant}
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
