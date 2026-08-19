// Focused, read-only workflow run details.
//
// Task-group lifecycle comes from the StreamLog; generated files and warnings
// come from the canonical round-indexed artifact facts. This component only
// joins and renders those facts—it does not infer or mutate workflow state.

import { Box, Text } from 'ink';

import { safeTerminalText } from '@cli/runtime/terminalText';
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from '@cli/tui/ui/colors';
import {
  CROSS,
  SKIP_CIRCLE,
  STATUS_DOT,
  TICK,
  TODO_PENDING,
  WARNING,
} from '@cli/tui/ui/glyphs';
import {
  STREAM_PHASE,
  WORKFLOW_TASK_STATUS_LABEL,
  outputDiffCounts,
  outputDisplayName,
  roundIndexedEntries,
  type CompileFailure,
  type OutputFileInfo,
  type RoundIndexed,
  type TaskGroup,
  type TaskGroupStatus,
} from '@shared/schemas';
import { formatRoundStageLabel } from '@shared/streams/streamStatusDisplay';
import { filterNotNullish, formatCompactDuration } from '@utils/core';

type WorkflowRunDetailTone =
  'neutral' | 'muted' | 'success' | 'warning' | 'error';

export interface WorkflowRunDetailLine {
  readonly key: string;
  readonly text: string;
  readonly tone: WorkflowRunDetailTone;
  readonly role: 'lifecycle' | 'outputHeading' | 'output' | 'alert';
}

type WorkflowRunFacts = {
  readonly taskGroups: readonly TaskGroup[];
  readonly outputFilesByRound: RoundIndexed<OutputFileInfo>;
  readonly missingOutputsByRound: RoundIndexed<string>;
  readonly compileFailuresByRound: RoundIndexed<CompileFailure>;
};

interface WorkflowRunDetailGroup {
  readonly key: string;
  readonly lines: readonly WorkflowRunDetailLine[];
  readonly priority: number;
  readonly planned: boolean;
}

const TASK_GROUP_APPEARANCE = {
  [STREAM_PHASE.RUNNING]: { marker: STATUS_DOT, tone: 'neutral' },
  [STREAM_PHASE.COMPLETED]: { marker: TICK, tone: 'success' },
  [STREAM_PHASE.CANCELLED]: { marker: SKIP_CIRCLE, tone: 'muted' },
  [STREAM_PHASE.FAILED]: { marker: CROSS, tone: 'error' },
} as const satisfies Record<
  TaskGroupStatus,
  { readonly marker: string; readonly tone: WorkflowRunDetailTone }
>;

const LINE_COLORS = {
  neutral: undefined,
  muted: COLOR_BORDER,
  success: COLOR_SUCCESS,
  warning: COLOR_WARNING,
  error: COLOR_ERROR,
} as const satisfies Record<WorkflowRunDetailTone, string | undefined>;

function taskGroupLine(group: TaskGroup, label: string): WorkflowRunDetailLine {
  const appearance = TASK_GROUP_APPEARANCE[group.status];
  const duration =
    group.endTime !== undefined
      ? ` · ${formatCompactDuration(group.endTime - group.startTime)}`
      : '';
  return {
    key: `group:${group.id}`,
    text: `${appearance.marker} ${safeTerminalText(label)} ${WORKFLOW_TASK_STATUS_LABEL[group.status]}${duration}`,
    tone: appearance.tone,
    role: 'lifecycle',
  };
}

function lifecyclePriority(
  status: TaskGroupStatus | undefined,
  currentRound: boolean,
  planned: boolean,
): number {
  if (status === STREAM_PHASE.FAILED) return 0;
  if (status === STREAM_PHASE.RUNNING) return 1;
  if (currentRound) return 2;
  if (!planned) return 3;
  return 5;
}

function workflowRunDetailGroups(
  facts: WorkflowRunFacts | undefined,
): WorkflowRunDetailGroup[] {
  if (!facts) return [];

  const groups: WorkflowRunDetailGroup[] = [];
  const roundGroups = new Map<number, TaskGroup>();
  const rounds = new Set<number>();
  for (const group of facts.taskGroups) {
    const index = group.kind === 'round' ? group.index : undefined;
    if (index !== undefined) {
      roundGroups.set(index, group);
      rounds.add(index);
      if (group.total !== undefined) {
        for (let round = 0; round < group.total; round += 1) rounds.add(round);
      }
      continue;
    }
    if (group.kind === 'phase') continue;
    groups.push({
      key: `lifecycle:${group.id}`,
      lines: [
        taskGroupLine(
          group,
          group.name || (group.kind === 'run' ? 'Workflow' : group.id),
        ),
      ],
      priority: lifecyclePriority(group.status, false, false) + 1,
      planned: false,
    });
  }
  for (const [round] of [
    ...roundIndexedEntries(facts.outputFilesByRound),
    ...roundIndexedEntries(facts.missingOutputsByRound),
    ...roundIndexedEntries(facts.compileFailuresByRound),
  ]) {
    rounds.add(round);
  }

  const plannedTotal = Math.max(
    0,
    ...[...roundGroups.values()]
      .map((group) => group.total)
      .filter(filterNotNullish),
  );
  const currentRound = Math.max(-1, ...roundGroups.keys());
  for (const round of [...rounds].toSorted((left, right) => left - right)) {
    const group = roundGroups.get(round);
    const planned = group === undefined && round < plannedTotal;
    const lines: WorkflowRunDetailLine[] = [];
    if (group) {
      lines.push(
        taskGroupLine(
          group,
          formatRoundStageLabel({ index: round, total: group.total }),
        ),
      );
    } else {
      const label = planned
        ? `${formatRoundStageLabel({ index: round, total: plannedTotal })} ${WORKFLOW_TASK_STATUS_LABEL.planned}`
        : `${formatRoundStageLabel({ index: round })} results`;
      lines.push({
        key: `round:${round}`,
        text: `${TODO_PENDING} ${label}`,
        tone: 'muted',
        role: 'lifecycle',
      });
    }

    const outputs = facts.outputFilesByRound[round] ?? [];
    if (outputs.length > 0) {
      lines.push({
        key: `outputs:${round}`,
        text: `  Generated files`,
        tone: 'muted',
        role: 'outputHeading',
      });
      for (const [index, file] of outputs.entries()) {
        const counts = outputDiffCounts(file.diff);
        const diff = counts ? ` (+${counts.added} -${counts.removed})` : '';
        lines.push({
          key: `output:${round}:${file.location.absolutePath}:${index}`,
          // Neutral bullet, not `›` — POINTER means "focused row / your
          // input" everywhere else, and these are static file rows.
          text: `    • ${safeTerminalText(outputDisplayName(file))}${diff}`,
          tone: 'neutral',
          role: 'output',
        });
      }
    }
    for (const [index, path] of (
      facts.missingOutputsByRound[round] ?? []
    ).entries()) {
      lines.push({
        key: `missing:${round}:${path}:${index}`,
        text: `  ${WARNING} ${formatRoundStageLabel({ index: round })} · Missing expected output: ${safeTerminalText(path)}`,
        tone: 'warning',
        role: 'alert',
      });
    }
    for (const [index, failure] of (
      facts.compileFailuresByRound[round] ?? []
    ).entries()) {
      lines.push({
        key: `compile:${round}:${failure.log.absolutePath}:${index}`,
        text: `  ${CROSS} ${formatRoundStageLabel({ index: round })} · Compile check failed: ${safeTerminalText(failure.displayName)} · ${safeTerminalText(failure.logRelativePath)}`,
        tone: 'error',
        role: 'alert',
      });
    }
    groups.push({
      key: `round:${round}`,
      lines,
      priority: lifecyclePriority(
        group?.status,
        group !== undefined && round === currentRound,
        planned,
      ),
      planned,
    });
  }

  return groups;
}

/**
 * Select a compact, structurally valid workflow summary for a constrained
 * viewport. Alerts and the current lifecycle receive space before future
 * plans; an artifact is never shown without its round and section headings.
 */
export function selectWorkflowRunDetailLines(
  facts: WorkflowRunFacts | undefined,
  capacity: number,
): WorkflowRunDetailLine[] {
  if (capacity <= 0) return [];
  const groups = workflowRunDetailGroups(facts);
  const allLines = groups.flatMap((group) => group.lines);
  if (allLines.length <= capacity) return allLines;

  const selected = new Map<string, Set<number>>();
  let remaining = capacity;
  const rankedGroups = groups.toSorted(
    (left, right) => left.priority - right.priority,
  );
  const hasLine = (group: WorkflowRunDetailGroup, index: number): boolean =>
    selected.get(group.key)?.has(index) ?? false;
  const addLine = (group: WorkflowRunDetailGroup, index: number): boolean => {
    if (remaining <= 0 || hasLine(group, index)) return false;
    const indices = selected.get(group.key) ?? new Set<number>();
    indices.add(index);
    selected.set(group.key, indices);
    remaining -= 1;
    return true;
  };
  const addWithLifecycle = (
    group: WorkflowRunDetailGroup,
    index: number,
  ): boolean => {
    const required = hasLine(group, 0) ? 1 : 2;
    // Alert text carries its rN identity, so the alert remains meaningful
    // alone when only one physical row is available.
    if (remaining < required) return addLine(group, index);
    addLine(group, 0);
    return addLine(group, index);
  };

  // First preserve actionable errors, then warnings, together with their
  // round whenever capacity permits.
  for (const tone of ['error', 'warning'] as const) {
    for (const group of rankedGroups) {
      for (const [index, line] of group.lines.entries()) {
        if (line.role === 'alert' && line.tone === tone) {
          addWithLifecycle(group, index);
        }
      }
    }
  }

  // Then retain active, failed, current, and completed lifecycle context.
  for (const group of rankedGroups) {
    if (!group.planned) addLine(group, 0);
  }

  // Generated paths require both their round and "Generated files" heading.
  for (const group of rankedGroups) {
    const headingIndex = group.lines.findIndex(
      (line) => line.role === 'outputHeading',
    );
    if (headingIndex < 0) continue;
    for (const [index, line] of group.lines.entries()) {
      if (line.role !== 'output') continue;
      const required =
        (hasLine(group, 0) ? 0 : 1) +
        (hasLine(group, headingIndex) ? 0 : 1) +
        1;
      if (remaining < required) break;
      addLine(group, 0);
      addLine(group, headingIndex);
      addLine(group, index);
    }
  }

  // Planned rounds are useful orientation, but never displace live evidence.
  for (const group of rankedGroups) {
    if (group.planned) addLine(group, 0);
  }

  return groups.flatMap((group) => {
    const indices = selected.get(group.key);
    return indices
      ? group.lines.filter((_line, index) => indices.has(index))
      : [];
  });
}

export function WorkflowRunDetails({
  lines,
  width,
}: {
  readonly lines: readonly WorkflowRunDetailLine[];
  readonly width?: number;
}): React.JSX.Element {
  return (
    <>
      {lines.map((line) => (
        <Box key={line.key} height={1} overflowY="hidden" width={width}>
          <Text color={LINE_COLORS[line.tone]} wrap="truncate-end">
            {line.text}
          </Text>
        </Box>
      ))}
    </>
  );
}
