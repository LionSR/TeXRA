// Focused, read-only document task run details.
//
// Stage lifecycle comes from the transcript; generated files and warnings
// come from the rounds of the run's documents fact. This component only
// joins and renders those facts—it does not infer or mutate the task's state.

import { Box, Text } from 'ink';

import {
  fileLocationDisplayPath,
  type RunView,
  type Stage,
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
import { stageStatus } from '@ui/copy/runStatus';

import { COMPACTION_ACTIVITY_STATUS_STYLE } from './transcriptEntryLayout';

interface DocumentTaskRunDetailLine {
  readonly key: string;
  readonly text: string;
  /** Undefined paints in the terminal's default foreground. */
  readonly color: string | undefined;
  readonly role: 'lifecycle' | 'outputHeading' | 'output' | 'alert';
}

type DocumentTaskRunFacts = {
  readonly stages: readonly Stage[];
  /** The run the stages are of: an open one reads as the run reads. */
  readonly run: Pick<RunView, 'holder' | 'outcome'>;
  /** The run's rounds, as its documents fact records them. */
  readonly rounds: readonly RoundOutput[];
};

interface DocumentTaskRunDetailGroup {
  readonly key: string;
  readonly lines: readonly DocumentTaskRunDetailLine[];
  readonly priority: number;
}

function stageLine(
  stage: Stage,
  status: ReturnType<typeof stageStatus>,
): DocumentTaskRunDetailLine {
  const appearance = COMPACTION_ACTIVITY_STATUS_STYLE[status.key];
  const duration =
    stage.endTime !== undefined
      ? ` · ${formatCompactDuration(stage.endTime - stage.startTime)}`
      : '';
  return {
    key: `stage:${stage.id}`,
    // Worded as the progress view's stage header words it, never with the
    // call-status vocabulary that happens to share key names.
    text: `${appearance.marker} ${safeTerminalText(stage.name || stage.id)} ${status.word}${duration}`,
    color: appearance.color,
    role: 'lifecycle',
  };
}

function lifecyclePriority(status: ReturnType<typeof stageStatus>): number {
  if (status.key === 'failed') return 0;
  if (status.key === 'running') return 1;
  return 3;
}

/** A round's results rank after failed and running stages. */
const ROUND_PRIORITY = 3;

function documentTaskRunDetailGroups(
  facts: DocumentTaskRunFacts | undefined,
): DocumentTaskRunDetailGroup[] {
  if (!facts) return [];

  const groups: DocumentTaskRunDetailGroup[] = [];
  for (const stage of facts.stages) {
    const status = stageStatus(stage, facts.run);
    groups.push({
      key: `lifecycle:${stage.id}`,
      lines: [stageLine(stage, status)],
      priority: lifecyclePriority(status) + 1,
    });
  }
  for (const record of facts.rounds) {
    const { round, outputs, missingOutputs: missing, reply } = record;
    const lines: DocumentTaskRunDetailLine[] = [
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
 * Select a compact, structurally valid document task summary for a constrained
 * viewport. Alerts receive space before lifecycle and artifacts; an artifact
 * is never shown without its round and section headings.
 */
export function selectDocumentTaskRunDetailLines(
  facts: DocumentTaskRunFacts | undefined,
  capacity: number,
): DocumentTaskRunDetailLine[] {
  if (capacity <= 0) return [];
  const groups = documentTaskRunDetailGroups(facts);
  const allLines = groups.flatMap((group) => group.lines);
  if (allLines.length <= capacity) return allLines;

  const selected = new Map<string, Set<number>>();
  let remaining = capacity;
  const rankedGroups = groups.toSorted(
    (left, right) => left.priority - right.priority,
  );
  const hasLine = (group: DocumentTaskRunDetailGroup, index: number): boolean =>
    selected.get(group.key)?.has(index) ?? false;
  const addLine = (
    group: DocumentTaskRunDetailGroup,
    index: number,
  ): boolean => {
    if (remaining <= 0 || hasLine(group, index)) return false;
    const indices = selected.get(group.key) ?? new Set<number>();
    indices.add(index);
    selected.set(group.key, indices);
    remaining -= 1;
    return true;
  };
  const addWithLifecycle = (
    group: DocumentTaskRunDetailGroup,
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

export function DocumentTaskRunDetails({
  lines,
  width,
}: {
  readonly lines: readonly DocumentTaskRunDetailLine[];
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
