// Focused, read-only workflow run details.
//
// Task-group lifecycle comes from the transcript; generated files and warnings
// come from the rounds of the run's documents fact. This component only
// joins and renders those facts—it does not infer or mutate workflow state.

import { Box, Text } from 'ink';

import {
  fileLocationDisplayPath,
  type TaskGroup,
  type TaskGroupStatus,
  formatCompactDuration,
} from '@texra-ai/harness/schemas';
import { safeTerminalText } from '@cli/runtime/terminal/terminalText';
import { COLOR_BORDER, COLOR_ERROR, COLOR_WARNING } from '@cli/tui/ui/colors';
import { CROSS, PENDING_BOX, TICK, WARNING } from '@cli/tui/ui/glyphs';
import {
  compileFailuresOf,
  formatRoundLabel,
  latexdiffDisplayName,
  outputDiffCounts,
  outputDisplayName,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import { runStatusLabel } from '@ui/copy/runStatus';

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
  /** The run's rounds, as its documents fact records them. */
  readonly rounds: readonly RoundOutput[];
};

interface WorkflowRunDetailGroup {
  readonly key: string;
  readonly lines: readonly WorkflowRunDetailLine[];
  readonly priority: number;
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
    // A task group's status is running or a run outcome, so it is worded
    // with the stream vocabulary — the same one the progress view's group
    // icon announces, never the workflow-call vocabulary that happens to
    // share key names.
    text: `${appearance.marker} ${safeTerminalText(label)} ${runStatusLabel(status)}${duration}`,
    color: appearance.color,
    role: 'lifecycle',
  };
}

function lifecyclePriority(status: TaskGroupStatus): number {
  if (status === 'failed') return 0;
  if (status === 'running') return 1;
  return 3;
}

/** A round's results rank after failed and running groups. */
const ROUND_PRIORITY = 3;

function workflowRunDetailGroups(
  facts: WorkflowRunFacts | undefined,
): WorkflowRunDetailGroup[] {
  if (!facts) return [];

  const groups: WorkflowRunDetailGroup[] = [];
  for (const group of facts.taskGroups) {
    groups.push({
      key: `lifecycle:${group.id}`,
      lines: [
        taskGroupLine(
          group,
          group.name || (group.kind === 'run' ? 'Workflow' : group.id),
          group.status,
        ),
      ],
      priority: lifecyclePriority(group.status) + 1,
    });
  }
  for (const record of facts.rounds) {
    const { round, outputs, missingOutputs: missing, reply } = record;
    const lines: WorkflowRunDetailLine[] = [
      {
        key: `round:${round}`,
        text: `${PENDING_BOX} ${formatRoundLabel(round)} results`,
        color: COLOR_BORDER,
        role: 'lifecycle',
      },
    ];

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
    if (reply && (outputs.length === 0 || missing.length > 0))
      lines.push({
        key: `reply:${round}`,
        text: `  ${WARNING} ${formatRoundLabel(round)} · ${outputs.length === 0 ? 'Wrote no documents; reply' : 'Reply'} kept at ${safeTerminalText(reply.absolutePath)}`,
        color: COLOR_WARNING,
        role: 'alert',
      });
    for (const [index, path] of missing.entries()) {
      lines.push({
        key: `missing:${round}:${path}:${index}`,
        text: `  ${WARNING} ${formatRoundLabel(round)} · Missing output: ${safeTerminalText(path)}`,
        color: COLOR_WARNING,
        role: 'alert',
      });
    }
    for (const [index, failure] of compileFailuresOf(record).entries()) {
      lines.push({
        key: `compile:${round}:${failure.log.absolutePath}:${index}`,
        text: `  ${CROSS} ${formatRoundLabel(round)} · Compile check failed: ${safeTerminalText(failure.displayName)} · ${safeTerminalText(failure.logRelativePath)}`,
        color: COLOR_ERROR,
        role: 'alert',
      });
    }
    for (const [index, entry] of record.latexdiffs.entries()) {
      lines.push({
        key: `latexdiff:${round}:${index}`,
        text: `  ${entry.status === 'ok' ? TICK : CROSS} ${formatRoundLabel(round)} · Latexdiff: ${safeTerminalText(latexdiffDisplayName(entry))}${entry.status === 'failed' ? ` — ${safeTerminalText(entry.error)}` : ''}`,
        color: entry.status === 'ok' ? undefined : COLOR_ERROR,
        role: entry.status === 'ok' ? 'output' : 'alert',
      });
    }
    groups.push({ key: `round:${round}`, lines, priority: ROUND_PRIORITY });
  }

  return groups;
}

/**
 * Select a compact, structurally valid workflow summary for a constrained
 * viewport. Alerts receive space before lifecycle and artifacts; an artifact
 * is never shown without its round and section headings.
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
  ): void => {
    const required = hasLine(group, 0) ? 1 : 2;
    // Alert text carries its rN identity, so the alert remains meaningful
    // alone when only one physical row is available.
    if (remaining >= required) addLine(group, 0);
    addLine(group, index);
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

  // Then retain active, failed, and completed lifecycle context.
  for (const group of rankedGroups) addLine(group, 0);

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
