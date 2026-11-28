import { Text, useWindowSize } from 'ink';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { confirmCardContentWidth } from '@cli/tui/ui/theme';

import type { SurfaceDecision } from '@texra/shared/session/surfaceDecision';
import { REQUEST_ASK, WORKING_DIRECTORY_LABEL } from '@ui/copy/requestCards';
import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import type {
  ApprovalBypassKind,
  RequestPayload,
} from '@texra-ai/worldline/schemas';

interface BashRequestProps {
  readonly availableRows: number;
  readonly payload: Extract<RequestPayload, { kind: 'bash' }>['data'];
  /** The run grant the request offers (`offeredGrant`). */
  readonly grant: ApprovalBypassKind | null;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

export function BashRequest(props: BashRequestProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const commandWidth = confirmCardContentWidth(columns);
  const cwd = props.payload.cwd?.trim();
  const cwdLine = cwd ? `${WORKING_DIRECTORY_LABEL}: ${cwd}` : undefined;
  const maxCommandRows = scrollableModalTextRowsBudget({
    availableRows: props.availableRows,
    columns,
    extraFixedRows: cwdLine ? 1 : 0,
    title: REQUEST_ASK.command,
  });

  return (
    <ConfirmCard
      color={COLOR_WARNING}
      title={REQUEST_ASK.command}
      kind="bash"
      grant={props.grant}
      onDecide={props.onDecide}
    >
      {cwdLine && (
        <Text dimColor wrap="truncate-end">
          {cwdLine}
        </Text>
      )}
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
