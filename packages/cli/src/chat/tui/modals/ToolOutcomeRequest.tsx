import { useWindowSize } from 'ink';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { confirmCardContentWidth } from '@cli/tui/ui/theme';
import type { ToolOutcomePermission } from '@shared/schemas';
import type { SurfaceDecision } from '@shared/session/approvalDecision';
import { TOOL_OUTCOME_COPY } from '@ui/transcript/toolOutcome';
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

/** A call that may have run with no recorded result: run it again, or skip
 *  it and tell the model its outcome is unknown. */
export function ToolOutcomeRequest(
  props: ToolOutcomeRequestProps,
): React.JSX.Element {
  const { columns } = useWindowSize();
  const title = TOOL_OUTCOME_COPY.question(props.payload);
  const text = `${props.payload.title}\n${TOOL_OUTCOME_COPY.explanation}`;
  return (
    <ConfirmCard
      color={COLOR_WARNING}
      title={title}
      approveLabel={TOOL_OUTCOME_COPY.runAgain.toLowerCase()}
      approveDecision={{ action: 'retry' }}
      rejectLabel={TOOL_OUTCOME_COPY.skip.toLowerCase()}
      rejectionMode="immediate"
      onDecide={props.onDecide}
    >
      <ScrollableModalText
        maxRows={scrollableModalTextRowsBudget({
          availableRows: props.availableRows,
          columns,
          title,
        })}
        scrollHint="scroll"
        text={text}
        width={confirmCardContentWidth(columns)}
      />
    </ConfirmCard>
  );
}
