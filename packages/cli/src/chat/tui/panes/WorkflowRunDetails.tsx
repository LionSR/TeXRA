// Focused, read-only workflow run details.
//
// Task-group lifecycle comes from the transcript fold; generated files and warnings
// come from the canonical round-indexed artifact facts. This component only
// joins and renders those facts—it does not infer or mutate workflow state.

import { Box, Text } from 'ink';

import { safeTerminalText } from '@cli/runtime/terminalText';
import { COLOR_BORDER, COLOR_ERROR, COLOR_WARNING } from '@cli/tui/ui/colors';
import { CROSS, TODO_PENDING, WARNING } from '@cli/tui/ui/glyphs';
import {
  RUN_PHASE,
  fileLocationDisplayPath,
  outputDiffCounts,
  outputDisplayName,
  roundIndexedEntries,
  type CompileFailure,
  type OutputFileInfo,
  type ReadonlyRoundIndexed,
  type RunOutcome,
  type TaskGroup,
  type TaskGroupStatus,
} from '@shared/schemas';
import {
  formatRoundStageLabel,
  formatRunStatusLabel,
} from '@shared/runs/runStatusDisplay';
import { taskGroupDisplayStatus } from '@shared/runs/taskGroupProjection';
import { filterNotNullish } from '@utils/core';
import { formatCompactDuration } from '@utils/text/stringUtils';

import { COMPACTION_ACTIVITY_STATUS_STYLE } from './transcriptEntryLayout';

interface WorkflowRunDetailLine {
  readonly key: string;
  readonly text: string;
  /** Undefined paints in the terminal's default foreground. */
  readonly color: string | undefined;
  readonly role: 'lifecycle' | 'outputHeading' | 'output' | 'alert';
}

type WorkflowRunFacts = {
  readonly taskGroups: readonly TaskGroup[];
  /** The outcome the run durably settled on — terminal with no producer left
   *  anywhere — so a group it never closed paints as that outcome instead of
   *  running forever. `undefined` paints each group as the transcript
   *  recorded it. */
  readonly runDurableOutcome?: RunOutcome;
  readonly outputFilesByRound: ReadonlyRoundIndexed<OutputFileInfo>;
  readonly missingOutputsByRound: ReadonlyRoundIndexed<string>;
  readonly compileFailuresByRound: ReadonlyRoundIndexed<CompileFailure>;
};

interface WorkflowRunDetailGroup {
  readonly key: string;
  readonly lines: readonly WorkflowRunDetailLine[];
  readonly priority: number;
  readonly planned: boolean;
}

function taskGroupLine(
  group: TaskGroup,
  label: string,
  status: TaskGroupStatus,
): WorkflowRunDetailLine {
  const appearance = COMPACTION_ACTIVITY_STATUS_STYLE[status];
  const duration =
    group.endTime !== undefined
      ? ` · ${formatCompactDuration(group.endTime - group.startTime)}`
      : '';
  return {
    key: `group:${group.id}`,
    // A task group's status is a RunPhase, so it is worded with the stream
    // vocabulary — the same one the progress view's group icon announces,
    // never the workflow-call vocabulary that happens to share key names.
    text: `${appearance.marker} ${safeTerminalText(label)} ${formatRunStatusLabel(status)}${duration}`,
    color: appearance.color,
    role: 'lifecycle',
  };
}

/** A workflow-agent round the run has not reached yet. */
const ROUND_PLANNED_LABEL = 'Planned';

function lifecyclePriority(
  status: TaskGroupStatus | undefined,
  currentRound: boolean,
  planned: boolean,
): number {
  if (status === RUN_PHASE.FAILED) return 0;
  if (status === RUN_PHASE.RUNNING) return 1;
  if (currentRound) return 2;
  if (!planned) return 3;
  return 5;
}

function workflowRunDetailGroups(
  facts: WorkflowRunFacts | undefined,
): WorkflowRunDetailGroup[] {
  if (!facts) return [];

  const groups: WorkflowRunDetailGroup[] = [];
  // One reading of every group's status, so the marker, the label and the
  // ordering priority cannot disagree about an unclosed group.
  const displayStatus = (group: TaskGroup): TaskGroupStatus =>
    taskGroupDisplayStatus(group, facts.runDurableOutcome);
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
          displayStatus(group),
        ),
      ],
      priority: lifecyclePriority(displayStatus(group), false, false) + 1,
      planned: false,
    });
  }
  for (const [round] of [
    ...roundIndexedEntries(facts.outputFilesByRound),
    ...roundIndexedEntries(facts.missingOutputsByRound).filter(
      ([, missing]) => missing.length > 0,
    ),
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
          displayStatus(group),
        ),
      );
    } else {
      const label = planned
        ? `${formatRoundStageLabel({ index: round, total: plannedTotal })} ${ROUND_PLANNED_LABEL}`
        : `${formatRoundStageLabel({ index: round })} results`;
      lines.push({
        key: `round:${round}`,
        text: `${TODO_PENDING} ${label}`,
        color: COLOR_BORDER,
        role: 'lifecycle',
      });
    }

    const outputs = facts.outputFilesByRound[round] ?? [];
    if (outputs.length > 0) {
      lines.push({
        key: `outputs:${round}`,
        text: `  Generated files`,
        color: COLOR_BORDER,
        role: 'outputHeading',
      });
      for (const [index, file] of outputs.entries()) {
        const counts = outputDiffCounts(file.diff);
        const diff = counts ? ` (+${counts.added} -${counts.removed})` : '';
        lines.push({
          key: `output:${round}:${file.location.absolutePath}:${index}`,
          // Neutral bullet, not `›` — POINTER means "focused row / your
          // input" everywhere else, and these are static file rows.
          text: `    • ${safeTerminalText(
            file.location.kind === 'external'
              ? fileLocationDisplayPath(file.location)
              : outputDisplayName(file),
          )}${diff}`,
          color: undefined,
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
        color: COLOR_WARNING,
        role: 'alert',
      });
    }
    for (const [index, failure] of (
      facts.compileFailuresByRound[round] ?? []
    ).entries()) {
      lines.push({
        key: `compile:${round}:${failure.log.absolutePath}:${index}`,
        text: `  ${CROSS} ${formatRoundStageLabel({ index: round })} · Compile check failed: ${safeTerminalText(failure.displayName)} · ${safeTerminalText(failure.logRelativePath)}`,
        color: COLOR_ERROR,
        role: 'alert',
      });
    }
    groups.push({
      key: `round:${round}`,
      lines,
      priority: lifecyclePriority(
        group && displayStatus(group),
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
  for (const color of [COLOR_ERROR, COLOR_WARNING]) {
    for (const group of rankedGroups) {
      for (const [index, line] of group.lines.entries()) {
        if (line.role === 'alert' && line.color === color) {
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
          <Text color={line.color} wrap="truncate-end">
            {line.text}
          </Text>
        </Box>
      ))}
    </>
  );
}
