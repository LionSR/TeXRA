import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { POINTER, TICK } from '@cli/tui/ui/glyphs';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { truncateSummaryToWidth } from '@cli/runtime/terminalText';
import { AgentCategory, type RunId } from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import { formatStageLabel } from '@shared/runs/runStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

import { childElapsed } from '../state/childControls';
import { killableRunId, runPhaseOf } from '../state/sessionView';
import {
  CHILD_ROW_METADATA_MIN_COLUMNS,
  CHILD_STATUS_MARKER,
  childRowMetadataText,
  CHILD_TONE_COLOR,
  pendingApprovalRowDisplay,
} from './SubagentListDisplay';
import { expandedRuns, type SessionListRow } from '../state/cliState';
import {
  pendingApprovalKindsByRun,
  type PendingApprovalKind,
} from '../state/approvalQueue';
import { useSignal } from '../state/useSignal';

const SUBAGENT_SUMMARY_MAX_COLUMNS = 100;

interface SegmentStyle {
  readonly bold?: boolean;
  readonly color?: string;
}

export function RowSegment({
  bold,
  children,
  color,
  dimColor,
  flexShrink,
}: SegmentStyle & {
  readonly children: React.ReactNode;
  readonly dimColor?: boolean;
  readonly flexShrink: number;
}): React.JSX.Element {
  return (
    <Box minWidth={0} flexShrink={flexShrink}>
      <Text bold={bold} color={color} dimColor={dimColor} wrap="truncate-end">
        {children}
      </Text>
    </Box>
  );
}

export function ApprovalSegments({
  approval,
  bold,
  color,
}: SegmentStyle & {
  readonly approval: ReturnType<typeof pendingApprovalRowDisplay>;
}): React.JSX.Element | null {
  if (!approval) return null;
  return (
    <>
      <Box flexShrink={0}>
        <Text bold={bold} color={color}>{` · ${approval.label}`}</Text>
      </Box>
      {approval.overflow ? (
        <RowSegment bold={bold} color={color} flexShrink={3}>
          {` ${approval.overflow}`}
        </RowSegment>
      ) : null}
    </>
  );
}

function SessionRow({
  active,
  focused,
  hiddenRowSummary,
  depth,
  expanded,
  metadataColumn,
  nowMs,
  pendingKinds,
  run,
}: {
  readonly active: boolean;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
  readonly depth: number;
  readonly expanded: boolean;
  readonly metadataColumn: boolean;
  readonly nowMs: number;
  readonly pendingKinds: readonly PendingApprovalKind[] | undefined;
  readonly run: RunView;
}): React.JSX.Element {
  const status = runPhaseOf(run);
  const statusLabel = run.statusLabel;
  const elapsed = childElapsed(
    { status, startedAt: run.runStartedAt ?? undefined },
    nowMs,
  );
  const approval = pendingApprovalRowDisplay(pendingKinds);
  const stageLabel = formatStageLabel(run.stage ?? undefined);
  const modelLabel = run.parentId === null ? undefined : run.modelLabel;
  const metadataText = metadataColumn
    ? childRowMetadataText({
        elapsed,
        outputTokens:
          run.usage.outputTokens > 0 ? run.usage.outputTokens : undefined,
        toolCallCount: run.conversationProgress.toolCallCount,
      })
    : undefined;
  const summary = run.description;
  const color = CHILD_TONE_COLOR[run.tone];
  return (
    <Box
      flexDirection="row"
      flexGrow={1}
      height={1}
      minWidth={0}
      overflowY="hidden"
    >
      <Text aria-hidden color={focused ? COLOR_HINT : undefined}>
        {focused ? POINTER : ' '}
      </Text>
      <Text aria-hidden color={active ? COLOR_HINT : undefined}>
        {active ? ` ${TICK} ` : '   '}
      </Text>
      <Text aria-hidden color={color}>
        {'  '.repeat(depth)}
        {run.category !== AgentCategory.Workflow && run.childIds.length > 0
          ? `${expanded ? '▾' : '▸'} `
          : '  '}
        {CHILD_STATUS_MARKER}
      </Text>
      <RowSegment bold={active} color={color} flexShrink={1}>
        {run.label}
        {statusLabel ? ` ${statusLabel}` : ''}
        {stageLabel ? ` · ${stageLabel}` : ''}
        {modelLabel ? ` · ${modelLabel}` : ''}
        {!metadataColumn && elapsed ? ` · ${elapsed}` : ''}
      </RowSegment>
      {!expanded && run.rollup.total > 0 ? (
        <RowSegment color={color} flexShrink={metadataColumn ? 0 : 1}>
          {` [${run.rollup.total} total · ${run.rollup.running} running · ${run.rollup.finished} finished]`}
        </RowSegment>
      ) : null}
      {run.group === 'interrupted' && run.resumeEligible ? (
        <RowSegment color={color} flexShrink={0}>
          {' '}
          · Resume
        </RowSegment>
      ) : null}
      {summary ? (
        <RowSegment dimColor flexShrink={2}>
          {` · ${truncateSummaryToWidth(summary, SUBAGENT_SUMMARY_MAX_COLUMNS)}`}
        </RowSegment>
      ) : null}
      <ApprovalSegments approval={approval} />
      {focused && hiddenRowSummary ? (
        <RowSegment dimColor flexShrink={4}>
          {` · ${hiddenRowSummary}`}
        </RowSegment>
      ) : null}
      {metadataText ? (
        <>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Text dimColor>{`  ${metadataText}`}</Text>
          </Box>
        </>
      ) : null}
    </Box>
  );
}

export interface SubagentListProps {
  readonly activeRunId?: RunId;
  readonly keyboardActive?: boolean;
  readonly maxRows?: number;
  readonly onCancel?: () => void;
  readonly onFocusRun?: (runId: RunId) => void;
  readonly onKillRun?: (runId: RunId) => void;
  readonly onSelectionChange?: (value: RunId) => void;
  readonly selectedValue?: RunId;
  readonly rows: readonly SessionListRow[];
}

export function SubagentList(
  props: SubagentListProps,
): React.JSX.Element | null {
  const rows = props.rows;
  const pendingApprovals = useSignal(pendingApprovalKindsByRun);
  const items = useMemo<SelectItem<SessionListRow>[]>(
    () =>
      rows.map((row) => ({
        value: row,
        label: row.kind === 'group' ? row.label : row.run.label,
        disabled: row.kind === 'group',
      })),
    [rows],
  );
  const startedAts = useMemo(
    () =>
      rows.flatMap((row) =>
        row.kind === 'run' ? [row.run.runStartedAt ?? undefined] : [],
      ),
    [rows],
  );
  const selectedRow = rows.find(
    (row) => row.kind === 'run' && row.run.id === props.selectedValue,
  );
  const nowMs = useLiveNowMsSince(startedAts);
  const { columns } = useWindowSize();
  const metadataColumn = columns >= CHILD_ROW_METADATA_MIN_COLUMNS;
  const contentRows =
    props.maxRows === undefined ? undefined : Math.max(0, props.maxRows - 1);
  useInput(
    (input, key) => {
      if (key.ctrl || key.meta || selectedRow?.kind !== 'run') return;
      const { run, expanded } = selectedRow;
      if (key.leftArrow || key.rightArrow || input === ' ') {
        const next = key.rightArrow || (!key.leftArrow && !expanded);
        expandedRuns.set(new Map(expandedRuns.get()).set(run.id, next));
      } else if (
        input.toLowerCase() === 'r' &&
        run.group === 'interrupted' &&
        run.resumeEligible
      ) {
        props.onFocusRun?.(run.id);
      } else if (input.toLowerCase() === 'k') {
        const runId = killableRunId(run);
        if (runId) props.onKillRun?.(runId);
      }
    },
    { isActive: props.keyboardActive ?? false },
  );
  if (items.length === 0 || (contentRows !== undefined && contentRows <= 0))
    return null;
  return (
    <Box
      flexDirection="column"
      height={contentRows}
      marginTop={1}
      overflowY={contentRows === undefined ? undefined : 'hidden'}
      paddingX={1}
      width={metadataColumn ? columns : undefined}
    >
      <Select
        activeValue={rows.find(
          (row) => row.kind === 'run' && row.run.id === props.activeRunId,
        )}
        highlightedValue={selectedRow ?? null}
        hotkeys={false}
        isActive={props.keyboardActive}
        items={items}
        maxVisibleItems={contentRows}
        onCancel={props.onCancel ?? (() => undefined)}
        wrap={false}
        onHighlightChange={(row) => {
          if (row.kind === 'run') props.onSelectionChange?.(row.run.id);
        }}
        onSelect={(row) => {
          if (row.kind === 'run') props.onFocusRun?.(row.run.id);
        }}
        renderItem={({ value: row }, state) =>
          row.kind === 'group' ? (
            <Text bold dimColor>
              {row.label}
            </Text>
          ) : (
            <SessionRow
              depth={row.depth}
              expanded={row.expanded}
              active={state.active}
              focused={state.focused}
              hiddenRowSummary={
                state.hiddenItemCount > 0
                  ? `+${formatResultCount(state.hiddenItemCount, 'row')}`
                  : undefined
              }
              metadataColumn={metadataColumn}
              nowMs={nowMs}
              pendingKinds={pendingApprovals.get(row.run.id)}
              run={row.run}
            />
          )
        }
      />
    </Box>
  );
}
