// Selected child-session facts shown separately from the compact child list.

// Third-party imports
import { Box, Text } from 'ink';

// Local imports - shared stream display
import { AgentCategory } from '@shared/schemas';
import { roundIndexedEntries } from '@shared/schemas/roundIndexed';
import {
  formatRoundStageLabel,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI rendering and state
import { truncateSummaryToWidth } from '../render/terminalText';
import type { StreamView } from '../state/streamViews';

const FILE_CATEGORIES = [
  ['input', 'Input'],
  ['context', 'Context'],
  ['media', 'Media'],
] as const;

/** Build the extension-style selected-stream summary used by the TUI. */
export function selectedSubagentDetailLines(
  session: StreamView | undefined,
  maxColumns: number,
): readonly string[] {
  if (!session) return [];
  const slice = session.slice;
  let category = 'agent';
  if (slice?.category === AgentCategory.Workflow) category = 'workflow agent';
  if (slice?.category === AgentCategory.ToolUse) category = 'tool-use agent';
  const lines = [`Selected ${category}: ${session.label}`];
  const status = formatStreamStatusLabel(slice?.status, {
    style: 'cli',
    isChildStream: session.parentId !== undefined,
    ...(slice?.substate ? { substate: slice.substate } : {}),
  });
  const round = formatRoundStageLabel(slice?.roundStage);
  const toolCalls = slice?.conversation?.toolCallCount;
  const progress = [
    status,
    round,
    toolCalls ? formatResultCount(toolCalls, 'tool call') : undefined,
  ].filter((part): part is string => part !== undefined);
  if (progress.length > 0) lines.push(`Progress: ${progress.join(' · ')}`);

  for (const [key, label] of FILE_CATEGORIES) {
    const paths = slice?.files?.[key] ?? [];
    for (const path of paths) {
      lines.push(`${label}: ${path}`);
    }
  }

  const outputRounds = roundIndexedEntries(slice?.outputFilesByRound ?? {})
    .filter(([, files]) => files.length > 0)
    .toReversed();
  if (outputRounds.length === 0) {
    const configuredOutputs = slice?.files?.output ?? [];
    if (configuredOutputs.length > 0) {
      lines.push(`Output: ${configuredOutputs.join(', ')}`);
    }
  } else {
    for (const [round, files] of outputRounds) {
      for (const file of files) {
        lines.push(`Output r${round + 1}: ${file.location.absolutePath}`);
      }
    }
  }

  return lines.map((line) => truncateSummaryToWidth(line, maxColumns));
}

export function SubagentDetailPanel({
  lines,
  maxRows,
}: {
  readonly lines: readonly string[];
  /** Includes the blank separator row above the detail surface. */
  readonly maxRows: number;
}): React.JSX.Element | null {
  const contentRows = Math.max(0, maxRows - 1);
  if (contentRows === 0 || lines.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      height={contentRows}
      marginTop={1}
      overflowY="hidden"
      paddingX={2}
    >
      {lines.slice(0, contentRows).map((line, index) => (
        <Text
          key={`${index}:${line}`}
          bold={index === 0}
          dimColor={index !== 0}
          wrap="truncate-end"
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}
