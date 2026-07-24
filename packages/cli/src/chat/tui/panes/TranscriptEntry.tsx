// Per-entry Ink presentation. Geometry and text rows come from
// transcriptEntryLayout; this module adds only role-specific styling and rich
// widgets.

// Third-party imports
import { memo } from 'react';
import { Box, Text } from 'ink';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

// Local imports - CLI TUI rendering
import { Markdown } from '../render/Markdown';
import { fillRows } from '../render/terminalText';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import { COLOR_ERROR, COLOR_HINT } from '../ui/colors';
import { STATUS_DOT } from '../ui/glyphs';
import { childStatusColor } from './SubagentListDisplay';
import { ToolUseRow } from './ToolUseRow';
import {
  LIVE_TAIL_ROWS,
  boundedTranscriptEntryLayout,
  transcriptEntryLayout,
  type TranscriptEntryLayout,
} from './transcriptEntryLayout';
import { isInquiryContinuationText } from './transcriptEntries';
import type {
  CompletedProcessTranscript,
  ConversationEntry,
} from '../state/cliState';

function displayLines(
  layout: TranscriptEntryLayout,
  fillWidth: boolean | undefined,
): readonly string[] {
  return fillWidth === true
    ? fillRows(layout.lines.join('\n'), layout.columns).split('\n')
    : layout.lines;
}

function PlainEntryRows({
  colorEnabled,
  entry,
  fillWidth,
  layout,
}: {
  readonly colorEnabled?: boolean;
  readonly entry: ConversationEntry;
  readonly fillWidth?: boolean;
  readonly layout: TranscriptEntryLayout;
}): React.JSX.Element {
  const isInquiryContinuation =
    entry.role === 'user' && isInquiryContinuationText(entry.text);
  // User turns are full-width inverse bands in both static and live panes.
  // Inquiry continuations remain ordinary prefixed rows and only fill when
  // their bounded caller requests it.
  const lines = displayLines(
    layout,
    fillWidth === true || (entry.role === 'user' && !isInquiryContinuation),
  );
  const paddingX = layout.inset / 2;
  const boxProps = {
    flexDirection: 'column' as const,
    marginBottom: layout.marginBottomRows,
    marginTop: layout.marginTopRows,
    paddingX,
  };

  if (isInquiryContinuation) {
    return (
      <Box {...boxProps}>
        {lines.map((line, index) => (
          <Text
            key={index}
            color={
              colorEnabled !== false && index === 0 ? COLOR_HINT : undefined
            }
            dimColor={colorEnabled !== false && index > 0}
          >
            {line}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box {...boxProps}>
      <Text
        color={
          entry.role === 'error' ||
          (entry.role === 'workflowTask' && entry.task.status === 'failed')
            ? COLOR_ERROR
            : undefined
        }
        inverse={entry.role === 'user' && colorEnabled !== false}
      >
        {lines.join('\n')}
      </Text>
    </Box>
  );
}

function ProcessEntryRow({
  fillWidth,
  layout,
  process,
}: {
  readonly fillWidth?: boolean;
  readonly layout: TranscriptEntryLayout;
  readonly process: CompletedProcessTranscript;
}): React.JSX.Element {
  if (fillWidth === true) {
    const entry: ConversationEntry = {
      finalized: true,
      id: process.executionId,
      process,
      role: 'process',
      text: '',
    };
    return <PlainEntryRows entry={entry} fillWidth layout={layout} />;
  }

  // Same status-to-color owner as the live SubagentList rows, so a cancelled
  // or stopped child finalizes with the neutral dot instead of a green one.
  const color = childStatusColor(process.status);
  const [, ...tailLines] = completedProcessDisplayLines(process);
  return (
    <Box
      flexDirection="column"
      marginBottom={layout.marginBottomRows}
      marginTop={layout.marginTopRows}
      paddingX={layout.inset / 2}
    >
      <Box>
        <Text color={color}>{STATUS_DOT} </Text>
        <Text>{process.title}</Text>
        {process.status ? <Text dimColor>{` · ${process.status}`}</Text> : null}
        {process.elapsed ? (
          <Text dimColor>{` · ${process.elapsed}`}</Text>
        ) : null}
        {process.isError ? <Text color={COLOR_ERROR}> · error</Text> : null}
      </Box>
      {process.tailLines.length > 0 ? (
        <Box marginLeft={2} flexDirection="column">
          {tailLines.map((line, index) => (
            <Text
              key={index}
              color={process.isError ? COLOR_ERROR : undefined}
              dimColor={!process.isError}
            >
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

// Entry objects stay reference-identical across stream ticks, so memoization
// limits wrapping and Markdown work to the entry that actually changed.
export const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  width,
  colorEnabled,
  fillWidth,
  subagentExecutionLabels,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
  readonly colorEnabled?: boolean;
  readonly fillWidth?: boolean;
  readonly subagentExecutionLabels?: ExecutionLabels;
}): React.JSX.Element {
  if (entry.role === 'tool') {
    return (
      <ToolUseRow
        subagentExecutionLabels={subagentExecutionLabels}
        toolUse={entry.toolUse}
        width={width}
      />
    );
  }

  const layout = transcriptEntryLayout(entry, {
    colorEnabled,
    mode: 'scrollback',
    width,
  });

  switch (entry.role) {
    case 'process':
      return (
        <ProcessEntryRow
          fillWidth={fillWidth}
          layout={layout}
          process={entry.process}
        />
      );
    case 'phase':
      // A bold, colored divider that separates a workflow-script run's phases
      // from the per-agent rows beneath. Stateless props-in → JSX-out.
      return (
        <Box
          marginBottom={layout.marginBottomRows}
          marginTop={layout.marginTopRows}
        >
          <Text bold color={colorEnabled !== false ? COLOR_HINT : undefined}>
            {layout.lines.join('\n')}
          </Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box
          marginBottom={layout.marginBottomRows}
          marginTop={layout.marginTopRows}
        >
          <Markdown
            content={entry.text}
            width={layout.columns}
            colorEnabled={colorEnabled}
            fillWidth={fillWidth}
          />
        </Box>
      );
    case 'workflowTask':
    default:
      return (
        <PlainEntryRows
          colorEnabled={colorEnabled}
          entry={entry}
          fillWidth={fillWidth}
          layout={layout}
        />
      );
  }
});

export const BoundedTranscriptEntry = memo(function BoundedTranscriptEntry({
  colorEnabled,
  entry,
  maxRows,
  subagentExecutionLabels,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly entry: ConversationEntry;
  readonly maxRows: number;
  readonly subagentExecutionLabels?: ExecutionLabels;
  readonly width?: number;
}): React.JSX.Element {
  if (entry.role === 'tool') {
    return (
      <ToolUseRow
        maxRows={maxRows}
        subagentExecutionLabels={subagentExecutionLabels}
        toolUse={entry.toolUse}
        width={width}
      />
    );
  }

  const layout = boundedTranscriptEntryLayout(
    transcriptEntryLayout(entry, {
      colorEnabled,
      maxRows,
      mode: 'bounded',
      width,
    }),
    maxRows,
  );
  return (
    <PlainEntryRows
      colorEnabled={colorEnabled}
      entry={entry}
      fillWidth
      layout={layout}
    />
  );
});

export const LiveTranscriptEntry = memo(function LiveTranscriptEntry({
  entry,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
}): React.JSX.Element {
  const layout = boundedTranscriptEntryLayout(
    transcriptEntryLayout(entry, { mode: 'live', width }),
    LIVE_TAIL_ROWS,
  );
  return <PlainEntryRows entry={entry} fillWidth layout={layout} />;
});
