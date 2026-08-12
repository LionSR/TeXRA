import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import { buildHunks } from '@cli/runtime/diffHunks';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import {
  clampModalWidth,
  EDIT_DIFF_PADDING,
  isCompactRows,
  MIN_MODAL_CONTENT_WIDTH,
} from '@cli/tui/ui/theme';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { formatResultCount } from '@utils/text/stringUtils';

import { ConfirmCard } from './ConfirmCard';
import {
  confirmCardContentRowsBudget,
  confirmCardFeedbackRows,
} from './confirmCardRowsBudget';
import {
  DiffView,
  initialDiffScrollOffset,
  maxDiffScrollOffset,
  statsFromHunks,
  wrappedDiffDisplayLines,
} from '../render/DiffView';
import { COMPACT_SCROLLABLE_CONTENT_ROWS } from '../render/scrollBounds';
import { useScrollableOffset } from '../state/useScrollableOffset';
import type { ApprovalDecision } from '../state/approvalQueue';

const EDIT_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE = 8;
const EDIT_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE = 5;
export const COMPACT_EDIT_APPROVAL_MAX_ROWS = 9;
const DEFAULT_EDIT_DIFF_ROWS = 30;
const EDIT_APPROVAL_FEEDBACK_PLACEHOLDER = 'Feedback to send with rejection';

export interface EditApprovalProps {
  readonly availableRows?: number;
  readonly request: ToolEditApprovalRequest;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function editApprovalDiffRowsBudget({
  availableRows,
  columns,
  feedbackPlaceholder = EDIT_APPROVAL_FEEDBACK_PLACEHOLDER,
  feedbackMode,
  feedbackValue = '',
  title,
}: {
  readonly availableRows?: number;
  readonly columns: number;
  readonly feedbackPlaceholder?: string;
  readonly feedbackMode?: boolean;
  readonly feedbackValue?: string;
  readonly title: string;
}): number {
  const feedbackRows =
    feedbackMode === true
      ? confirmCardFeedbackRows({
          columns,
          placeholder: feedbackPlaceholder,
          value: feedbackValue,
        })
      : 0;
  return confirmCardContentRowsBudget({
    availableRows,
    columns,
    title,
    minContentWidth: MIN_MODAL_CONTENT_WIDTH,
    defaultRows: DEFAULT_EDIT_DIFF_ROWS,
    compactMaxRows: COMPACT_SCROLLABLE_CONTENT_ROWS,
    spaciousFixedRows: EDIT_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE,
    compactFixedRows: EDIT_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE,
    extraFixedRows: feedbackRows,
  });
}

export function EditApproval(props: EditApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackValue, setFeedbackValue] = useState('');
  const [feedbackExitCount, setFeedbackExitCount] = useState(0);
  const feedbackModeRef = useRef(false);
  const feedbackWasCompactRef = useRef(false);
  const title = `Apply edit to ${props.request.path}?`;
  const diffWidth = clampModalWidth(columns - EDIT_DIFF_PADDING);
  const maxDiffLines = editApprovalDiffRowsBudget({
    availableRows: props.availableRows,
    columns,
    feedbackMode,
    feedbackValue,
    title,
  });

  // Single diff pass shared between the summary line and the inline view.
  const hunks = useMemo(
    () =>
      buildHunks(
        props.request.path,
        props.request.originalContent,
        props.request.proposedContent,
      ),
    [
      props.request.path,
      props.request.originalContent,
      props.request.proposedContent,
    ],
  );
  const stats = useMemo(() => statsFromHunks(hunks), [hunks]);
  const diffRows = useMemo(
    () => wrappedDiffDisplayLines(hunks, diffWidth).length,
    [diffWidth, hunks],
  );
  const maxScrollOffset = maxDiffScrollOffset(diffRows, maxDiffLines);
  const initialScrollOffset = useMemo(
    () => initialDiffScrollOffset(hunks, diffWidth, maxDiffLines),
    [diffWidth, hunks, maxDiffLines],
  );
  const scrollResetKey = useMemo(
    () => ({
      availableRows: props.availableRows,
      columns,
      feedbackExitCount,
      hunks,
      request: props.request,
    }),
    [columns, feedbackExitCount, hunks, props.availableRows, props.request],
  );
  const feedbackDiffIsCompact = useCallback(
    (value: string) =>
      editApprovalDiffRowsBudget({
        availableRows: props.availableRows,
        columns,
        feedbackMode: true,
        feedbackValue: value,
        title,
      }) <= COMPACT_SCROLLABLE_CONTENT_ROWS,
    [columns, props.availableRows, title],
  );
  useEffect(() => {
    if (feedbackMode && feedbackDiffIsCompact(feedbackValue)) {
      feedbackWasCompactRef.current = true;
    }
  }, [feedbackDiffIsCompact, feedbackMode, feedbackValue]);
  const handleFeedbackModeChange = useCallback(
    (active: boolean) => {
      if (active && feedbackDiffIsCompact(feedbackValue)) {
        feedbackWasCompactRef.current = true;
      }
      if (feedbackModeRef.current && !active && feedbackWasCompactRef.current) {
        setFeedbackExitCount((count) => count + 1);
      }
      if (!active) feedbackWasCompactRef.current = false;
      feedbackModeRef.current = active;
      setFeedbackMode(active);
    },
    [feedbackDiffIsCompact, feedbackValue],
  );
  const { scrollOffset, scrollable: diffScrollable } = useScrollableOffset({
    initialOffset: initialScrollOffset,
    maxScrollOffset,
    pageRows: Math.max(1, maxDiffLines - 2),
    resetKey: scrollResetKey,
  });
  const compactDiffLayout = maxDiffLines <= COMPACT_SCROLLABLE_CONTENT_ROWS;
  const compactCard = isCompactRows(
    props.availableRows,
    COMPACT_EDIT_APPROVAL_MAX_ROWS,
  );

  return (
    <ConfirmCard
      borderStyle="double"
      color={COLOR_HINT}
      title={title}
      rejectionMode="feedback"
      alwaysAllow={{ kind: 'toolEdit', label: 'approve edits for session' }}
      feedbackPlaceholder={EDIT_APPROVAL_FEEDBACK_PLACEHOLDER}
      compact={compactCard}
      onFeedbackModeChange={handleFeedbackModeChange}
      onFeedbackValueChange={setFeedbackValue}
      onDecide={props.onDecide}
    >
      <Text dimColor>
        +{stats.added} / −{stats.removed} ·{' '}
        {formatResultCount(stats.hunks, 'hunk')} · source:{' '}
        {props.request.sourceTool}
      </Text>
      <Box marginY={compactDiffLayout ? 0 : 1} flexDirection="column">
        <DiffView
          hunks={hunks}
          maxDisplayLines={maxDiffLines}
          scrollOffset={scrollOffset}
          width={diffWidth}
        />
      </Box>
      {diffScrollable ? (
        <KeyHints
          confirmCancel={false}
          hints={[
            { key: '↑/↓', action: 'scroll diff' },
            { key: 'PgUp/PgDn', action: 'page' },
          ]}
        />
      ) : null}
    </ConfirmCard>
  );
}
