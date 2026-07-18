import { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { formatResultCount } from '@utils/text/stringUtils';

import { ConfirmCard } from './ConfirmCard';
import { COLOR_HINT } from '../ui/colors';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
  EDIT_DIFF_PADDING,
  MIN_MODAL_CONTENT_WIDTH,
} from '../ui/theme';
import { confirmCardContentRowsBudget } from './confirmCardRowsBudget';
import {
  buildHunks,
  COMPACT_DIFF_DISPLAY_LINES,
  diffVisualRowCount,
  DiffView,
  initialDiffScrollOffset,
  maxDiffScrollOffset,
  statsFromHunks,
} from '../render/DiffView';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { KeyHints } from '../ui/KeyHints';
import { useScrollableOffset } from '../state/useScrollableOffset';
import type { ApprovalDecision } from '../state/approvalQueue';

const EDIT_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE = 8;
const EDIT_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE = 5;
const EDIT_APPROVAL_FEEDBACK_MARGIN_ROWS = 1;
const EDIT_APPROVAL_FEEDBACK_PREFIX_COLUMNS = 2;
export const COMPACT_EDIT_APPROVAL_MAX_ROWS = 9;
const DEFAULT_EDIT_DIFF_ROWS = 30;
const EDIT_APPROVAL_FEEDBACK_PLACEHOLDER = 'Why reject?';

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
      ? editApprovalFeedbackRows({
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
    compactMaxRows: COMPACT_DIFF_DISPLAY_LINES,
    spaciousFixedRows: EDIT_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE,
    compactFixedRows: EDIT_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE,
    extraFixedRows: feedbackRows,
  });
}

export function editApprovalFeedbackRows({
  columns,
  placeholder,
  value,
}: {
  readonly columns: number;
  readonly placeholder: string;
  readonly value: string;
}): number {
  const text = value.length > 0 ? value : placeholder;
  const width = Math.max(
    1,
    columns -
      CONFIRM_CARD_HORIZONTAL_DECORATION -
      EDIT_APPROVAL_FEEDBACK_PREFIX_COLUMNS,
  );
  return (
    EDIT_APPROVAL_FEEDBACK_MARGIN_ROWS +
    Math.max(1, wrapAnsiToWidth(text, width).split('\n').length)
  );
}

export function formatEditApprovalHunkCount(count: number): string {
  return formatResultCount(count, 'hunk');
}

export function EditApproval(props: EditApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackValue, setFeedbackValue] = useState('');
  const [feedbackExitCount, setFeedbackExitCount] = useState(0);
  const feedbackModeRef = useRef(false);
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
    () => diffVisualRowCount(hunks, diffWidth),
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
      }) <= COMPACT_DIFF_DISPLAY_LINES,
    [columns, props.availableRows, title],
  );
  const handleFeedbackModeChange = useCallback(
    (active: boolean) => {
      if (
        feedbackModeRef.current &&
        !active &&
        feedbackDiffIsCompact(feedbackValue)
      ) {
        setFeedbackExitCount((count) => count + 1);
      }
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
  const compactDiffLayout = maxDiffLines <= COMPACT_DIFF_DISPLAY_LINES;
  const compactCard =
    props.availableRows !== undefined &&
    props.availableRows <= COMPACT_EDIT_APPROVAL_MAX_ROWS;

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
        {formatEditApprovalHunkCount(stats.hunks)} · source:{' '}
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
