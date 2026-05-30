import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';

import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

import { ConfirmCard } from './ConfirmCard';
import {
  buildHunks,
  diffVisualRowCount,
  DiffView,
  maxDiffScrollOffset,
  statsFromHunks,
} from '../render/DiffView';
import { KeyHints } from '../ui/KeyHints';
import type { ApprovalDecision } from '../state/approvalQueue';

const EDIT_DIFF_PADDING = 6;
const EDIT_APPROVAL_FIXED_ROWS = 8;
const MIN_EDIT_DIFF_WIDTH = 20;

export interface EditApprovalProps {
  readonly availableRows?: number;
  readonly request: ToolEditApprovalRequest;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function EditApproval(props: EditApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [scrollOffset, setScrollOffset] = useState(0);
  const diffWidth = Math.max(MIN_EDIT_DIFF_WIDTH, columns - EDIT_DIFF_PADDING);
  const maxDiffLines =
    props.availableRows === undefined
      ? 30
      : Math.max(1, props.availableRows - EDIT_APPROVAL_FIXED_ROWS);

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
      title={`Apply edit to ${props.request.path}?`}
      alwaysAllow={{ kind: 'toolEdit', label: 'approve session' }}
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
