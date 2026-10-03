import { useWindowSize } from 'ink';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { confirmCardContentWidth } from '@cli/tui/ui/theme';
import type { ToolOutcomePermission } from '@shared/schemas';
import type { SurfaceDecision } from '@shared/session/approvalDecision';
import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';

interface ToolOutcomeRequestProps {
  readonly availableRows?: number;
  readonly payload: ToolOutcomePermission;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

const TOOL_OUTCOME_TITLE = 'Run the interrupted call again?';

/** A call that may have run with no recorded result: run it again, or skip
 *  it and tell the model its outcome is unknown. */
export function ToolOutcomeRequest(
  props: ToolOutcomeRequestProps,
): React.JSX.Element {
  const { columns } = useWindowSize();
  const { title, childRunId } = props.payload;
  const text = childRunId === null ? title : `${title}\nRun ${childRunId}`;
  return (
    <ConfirmCard
      color={COLOR_WARNING}
      title={TOOL_OUTCOME_TITLE}
      approveLabel="run again"
      approveDecision={{ action: 'retry' }}
      rejectLabel="skip"
      rejectionMode="immediate"
      onDecide={props.onDecide}
    >
      <ScrollableModalText
        maxRows={scrollableModalTextRowsBudget({
          availableRows: props.availableRows,
          columns,
          title: TOOL_OUTCOME_TITLE,
        })}
        scrollHint="scroll"
        text={text}
        width={confirmCardContentWidth(columns)}
      />
    </ConfirmCard>
  );
}
