import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import { COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import { clampModalWidth, isCompactRows } from '@cli/tui/ui/theme';
import type { SurfaceDecision } from '@texra/shared/session/surfaceDecision';

import { ConfirmCard, ConfirmCardFeedback } from './ConfirmCard';
import { confirmCardContentRowsBudget } from './confirmCardRowsBudget';
import { ScrollHints } from './ScrollableModalText';
import {
  DiffView,
  initialDiffScrollOffset,
  wrappedDiffDisplayLines,
} from '../render/DiffView';
import {
  COMPACT_SCROLLABLE_CONTENT_ROWS,
  compactAwareMaxScrollOffset,
  scrollPageRows,
} from '../render/scrollBounds';
import { useScrollableOffset } from '../state/useScrollableOffset';
import {
  type ApprovalBypassKind,
  type ToolEditContent,
  formatResultCount,
} from '@texra-ai/harness/schemas';
import type { ToolEditTuiRequest } from '../state/approvalQueue';
import { formatLineChanges } from '@ui/copy/format';

const EDIT_DIFF_PADDING = 6;
const EDIT_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE = 8;
const EDIT_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE = 5;
const COMPACT_EDIT_APPROVAL_MAX_ROWS = 9;
const DEFAULT_EDIT_DIFF_ROWS = 30;

interface ToolEditRequestProps {
  readonly availableRows?: number;
  readonly payload: ToolEditTuiRequest;
  /** The run grant the request offers (`offeredGrant`). */
  readonly grant: ApprovalBypassKind | null;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

function toolEditDiffRowsBudget({
  availableRows,
  columns,
  feedbackRows = 0,
  title,
}: {
  readonly availableRows?: number;
  readonly columns: number;
  /** Rows the card's open rejection note takes (`ConfirmCardFeedback`). */
  readonly feedbackRows?: number;
  readonly title: string;
}): number {
  return confirmCardContentRowsBudget({
    availableRows,
    columns,
    title,
    defaultRows: DEFAULT_EDIT_DIFF_ROWS,
    compactMaxRows: COMPACT_SCROLLABLE_CONTENT_ROWS,
    spaciousFixedRows: EDIT_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE,
    compactFixedRows: EDIT_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE,
    extraFixedRows: feedbackRows,
  });
}

export function ToolEditRequest(
  props: ToolEditRequestProps,
): React.JSX.Element {
  const { data } = props.payload;
  const title = `Apply edit to ${data.relativePath}?`;
  return (
    <ConfirmCard
      color={COLOR_HINT}
      title={title}
      kind="toolEdit"
      grant={props.grant}
      compact={isCompactRows(
        props.availableRows,
        COMPACT_EDIT_APPROVAL_MAX_ROWS,
      )}
      onDecide={props.onDecide}
    >
      {props.payload.tui.kind === 'preview' ? (
        <ToolEditDiff
          availableRows={props.availableRows}
          content={props.payload.tui.content}
          payload={props.payload}
          title={title}
        />
      ) : (
        <>
          <Text dimColor>
            {formatLineChanges(data.addedLines, data.removedLines)} · source:{' '}
            {data.sourceTool}
          </Text>
          <Text color={COLOR_WARNING}>
            Preview unavailable: {props.payload.tui.reason}
          </Text>
        </>
      )}
    </ConfirmCard>
  );
}

function ToolEditDiff({
  availableRows,
  content,
  payload,
  title,
}: {
  readonly availableRows?: number;
  /** The staged preview the diff shows. */
  readonly content: ToolEditContent;
  readonly payload: ToolEditTuiRequest;
  readonly title: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const feedback = useContext(ConfirmCardFeedback);
  const [feedbackExitCount, setFeedbackExitCount] = useState(0);
  const feedbackWasCompactRef = useRef(false);
  const { data } = payload;
  const diffWidth = clampModalWidth(columns - EDIT_DIFF_PADDING);
  const maxDiffLines = toolEditDiffRowsBudget({
    availableRows,
    columns,
    feedbackRows: feedback.rows,
    title,
  });
  const compactDiffLayout = maxDiffLines <= COMPACT_SCROLLABLE_CONTENT_ROWS;

  // The request's own diff, shared by the summary line and the inline view.
  const { hunks } = content;
  const diffRows = useMemo(
    () => wrappedDiffDisplayLines(hunks, diffWidth).length,
    [diffWidth, hunks],
  );
  const maxScrollOffset = compactAwareMaxScrollOffset({
    maxDisplayLines: maxDiffLines,
    totalLines: diffRows,
  });
  const initialScrollOffset = useMemo(
    () => initialDiffScrollOffset(hunks, diffWidth, maxDiffLines),
    [diffWidth, hunks, maxDiffLines],
  );
  // A note that squeezed the diff into its compact layout moved the scroll
  // window, so closing that note restores the initial offset.
  useEffect(() => {
    if (feedback.mode) {
      if (compactDiffLayout) feedbackWasCompactRef.current = true;
    } else if (feedbackWasCompactRef.current) {
      feedbackWasCompactRef.current = false;
      setFeedbackExitCount((count) => count + 1);
    }
  }, [compactDiffLayout, feedback.mode]);
  const scrollResetKey = useMemo(
    () => ({ availableRows, columns, feedbackExitCount, hunks, payload }),
    [availableRows, columns, feedbackExitCount, hunks, payload],
  );
  const { scrollOffset, scrollable: diffScrollable } = useScrollableOffset({
    // The rejection note owns ↑/↓ while it is open.
    active: !feedback.mode,
    initialOffset: initialScrollOffset,
    maxScrollOffset,
    pageRows: scrollPageRows({ maxDisplayLines: maxDiffLines }),
    resetKey: scrollResetKey,
  });

  return (
    <>
      <Text dimColor>
        {formatLineChanges(data.addedLines, data.removedLines)} ·{' '}
        {formatResultCount(hunks.length, 'hunk')} · source: {data.sourceTool}
      </Text>
      <Box marginY={compactDiffLayout ? 0 : 1} flexDirection="column">
        <DiffView
          hunks={hunks}
          maxDisplayLines={maxDiffLines}
          scrollOffset={scrollOffset}
          width={diffWidth}
        />
      </Box>
      {diffScrollable && !compactDiffLayout && !feedback.mode ? (
        <ScrollHints action="scroll diff" />
      ) : null}
    </>
  );
}
