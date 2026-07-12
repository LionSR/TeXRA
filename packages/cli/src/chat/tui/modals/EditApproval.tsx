import { useMemo, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

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
  return `${count} ${count === 1 ? 'hunk' : 'hunks'}`;
}

export function EditApproval(props: EditApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackValue, setFeedbackValue] = useState('');
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
  const { scrollOffset, scrollable: diffScrollable } = useScrollableOffset({
    maxScrollOffset,
    pageRows: Math.max(1, maxDiffLines - 2),
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
      alwaysAllow={{ kind: 'toolEdit', label: 'approve edits for session' }}
      feedbackPlaceholder={EDIT_APPROVAL_FEEDBACK_PLACEHOLDER}
      compact={compactCard}
      onFeedbackModeChange={setFeedbackMode}
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
