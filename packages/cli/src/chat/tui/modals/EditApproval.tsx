import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';

import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

import { ConfirmCard, CONFIRM_CARD_HORIZONTAL_DECORATION } from './ConfirmCard';
import {
  buildHunks,
  diffVisualRowCount,
  DiffView,
  maxDiffScrollOffset,
  statsFromHunks,
} from '../render/DiffView';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { KeyHints } from '../ui/KeyHints';
import type { ApprovalDecision } from '../state/approvalQueue';

const EDIT_DIFF_PADDING = 6;
const EDIT_APPROVAL_FIXED_ROWS_EXCLUDING_TITLE = 8;
const EDIT_APPROVAL_FEEDBACK_MARGIN_ROWS = 1;
const EDIT_APPROVAL_FEEDBACK_PREFIX_COLUMNS = 2;
const MIN_EDIT_DIFF_WIDTH = 20;
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
  if (availableRows === undefined) return 30;

  const titleWidth = Math.max(
    MIN_EDIT_DIFF_WIDTH,
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const titleRows = wrapAnsiToWidth(title, titleWidth).split('\n').length;
  const feedbackRows =
    feedbackMode === true
      ? editApprovalFeedbackRows({
          columns,
          placeholder: feedbackPlaceholder,
          value: feedbackValue,
        })
      : 0;
  return Math.max(
    1,
    availableRows -
      EDIT_APPROVAL_FIXED_ROWS_EXCLUDING_TITLE -
      titleRows -
      feedbackRows,
  );
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

export function EditApproval(props: EditApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackValue, setFeedbackValue] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const title = `Apply edit to ${props.request.path}?`;
  const diffWidth = Math.max(MIN_EDIT_DIFF_WIDTH, columns - EDIT_DIFF_PADDING);
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
  const diffScrollable = maxScrollOffset > 0;
  const pageRows = Math.max(1, maxDiffLines - 2);

  function scrollTo(next: number | ((currentOffset: number) => number)): void {
    setScrollOffset((current) => {
      const requested = typeof next === 'function' ? next(current) : next;
      return Math.max(0, Math.min(maxScrollOffset, requested));
    });
  }

  useEffect(() => {
    setScrollOffset((current) =>
      Math.max(0, Math.min(maxScrollOffset, current)),
    );
  }, [maxScrollOffset]);

  useInput(
    (_input, key) => {
      if (key.downArrow) scrollTo((current) => current + 1);
      else if (key.upArrow) scrollTo((current) => current - 1);
      else if (key.pageDown) scrollTo((current) => current + pageRows);
      else if (key.pageUp) scrollTo((current) => current - pageRows);
    },
    { isActive: diffScrollable },
  );

  return (
    <ConfirmCard
      borderStyle="double"
      color="cyan"
      title={title}
      alwaysAllow={{ kind: 'toolEdit', label: 'approve session' }}
      feedbackPlaceholder={EDIT_APPROVAL_FEEDBACK_PLACEHOLDER}
      onFeedbackModeChange={setFeedbackMode}
      onFeedbackValueChange={setFeedbackValue}
      onDecide={props.onDecide}
    >
      <Text dimColor>
        +{stats.added} / −{stats.removed} · {stats.hunks} hunks · source:{' '}
        {props.request.sourceTool}
      </Text>
      <Box marginY={1} flexDirection="column">
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
