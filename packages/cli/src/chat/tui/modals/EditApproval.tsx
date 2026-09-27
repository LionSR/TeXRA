import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import { COLOR_HINT } from '@cli/tui/ui/colors';
import { clampModalWidth, isCompactRows } from '@cli/tui/ui/theme';
import type { SurfaceDecision } from '@shared/session/approvalDecision';
import { buildDiffHunks } from '@utils/text/unifiedDiff';
import { formatResultCount } from '@utils/text/stringUtils';

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
import type { ToolEditApprovalPayload } from '../state/approvalQueue';

const EDIT_DIFF_PADDING = 6;
const EDIT_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE = 8;
const EDIT_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE = 5;
export const COMPACT_EDIT_APPROVAL_MAX_ROWS = 9;
const DEFAULT_EDIT_DIFF_ROWS = 30;

interface EditApprovalProps {
  readonly availableRows?: number;
  readonly payload: ToolEditApprovalPayload;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

export function editApprovalDiffRowsBudget({
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

export function EditApproval(props: EditApprovalProps): React.JSX.Element {
  const title = `Apply edit to ${props.payload.data.relativePath}?`;
  return (
    <ConfirmCard
      borderStyle="double"
      color={COLOR_HINT}
      title={title}
      rejectionMode="feedback"
      alwaysAllowLabel="approve edits for session"
      compact={isCompactRows(
        props.availableRows,
        COMPACT_EDIT_APPROVAL_MAX_ROWS,
      )}
      onDecide={props.onDecide}
    >
      <EditApprovalDiff
        availableRows={props.availableRows}
        payload={props.payload}
        title={title}
      />
    </ConfirmCard>
  );
}

function EditApprovalDiff({
  availableRows,
  payload,
  title,
}: {
  readonly availableRows?: number;
  readonly payload: ToolEditApprovalPayload;
  readonly title: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const feedback = useContext(ConfirmCardFeedback);
  const [feedbackExitCount, setFeedbackExitCount] = useState(0);
  const feedbackWasCompactRef = useRef(false);
  const { data, tui } = payload;
  const diffWidth = clampModalWidth(columns - EDIT_DIFF_PADDING);
  const maxDiffLines = editApprovalDiffRowsBudget({
    availableRows,
    columns,
    feedbackRows: feedback.rows,
    title,
  });
  const compactDiffLayout = maxDiffLines <= COMPACT_SCROLLABLE_CONTENT_ROWS;

  // Single diff pass shared between the summary line and the inline view.
  const hunks = useMemo(
    () => buildDiffHunks(tui.originalContent, tui.proposedContent).hunks,
    [tui.originalContent, tui.proposedContent],
  );
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
        +{data.addedLines} / −{data.removedLines} ·{' '}
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
