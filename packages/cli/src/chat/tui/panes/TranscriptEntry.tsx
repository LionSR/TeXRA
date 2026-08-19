// Per-entry Ink presentation. Geometry and text rows come from
// transcriptEntryLayout; this module adds only role-specific styling and rich
// widgets.

// Third-party imports
import { memo } from 'react';
import { Box, Text } from 'ink';
import { COLOR_ERROR, COLOR_HINT } from '@cli/tui/ui/colors';
import { fillRows } from '@cli/runtime/terminalText';
import type { TranscriptRow } from '@shared/transcript';

// Local imports - CLI TUI rendering
import { Markdown } from '../render/Markdown';
import { ToolUseRow } from './ToolUseRow';
import {
  COMPACTION_ACTIVITY_STATUS_STYLE,
  LIVE_TAIL_ROWS,
  WORKFLOW_TASK_STATUS_STYLE,
  boundedTranscriptEntryLayout,
  transcriptEntryLayout,
  type TranscriptEntryLayout,
} from './transcriptEntryLayout';
import {
  isInquiryContinuationText,
  transcriptRowHeadline,
} from './transcriptEntries';

function PlainEntryRows({
  colorEnabled,
  entry,
  fillWidth,
  layout,
}: {
  readonly colorEnabled?: boolean;
  readonly entry: TranscriptRow;
  readonly fillWidth?: boolean;
  readonly layout: TranscriptEntryLayout;
}): React.JSX.Element {
  const isInquiryContinuation =
    entry.kind === 'user' && isInquiryContinuationText(entry.summary.full);
  // User turns are full-width inverse bands in both static and live panes.
  // Inquiry continuations remain ordinary prefixed rows and only fill when
  // their bounded caller requests it.
  const shouldFill =
    fillWidth === true || (entry.kind === 'user' && !isInquiryContinuation);
  const lines = shouldFill
    ? fillRows(layout.lines.join('\n'), layout.columns).split('\n')
    : layout.lines;
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

  // Workflow-call rows carry the same status color as their layout marker, so
  // the six statuses stay distinguishable at a glance.
  let rowColor: string | undefined;
  if (entry.kind === 'error') {
    rowColor = COLOR_ERROR;
  } else if (entry.kind === 'compactionActivity' && colorEnabled !== false) {
    rowColor = COMPACTION_ACTIVITY_STATUS_STYLE[entry.block.status].color;
  } else if (entry.kind === 'workflowTask' && colorEnabled !== false) {
    rowColor = WORKFLOW_TASK_STATUS_STYLE[entry.call.status].color;
  }

  return (
    <Box {...boxProps}>
      <Text
        color={rowColor}
        inverse={entry.kind === 'user' && colorEnabled !== false}
      >
        {lines.join('\n')}
      </Text>
    </Box>
  );
}

// Entry objects stay reference-identical across stream ticks, so memoization
// limits wrapping and Markdown work to the entry that actually changed.
export const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  previousEntry,
  width,
  colorEnabled,
  fillWidth,
}: {
  readonly entry: TranscriptRow;
  /** The row printed directly above this one, so its bottom separator can
   *  absorb this row's top one. Yoga does not collapse margins. */
  readonly previousEntry?: TranscriptRow;
  readonly width?: number;
  readonly colorEnabled?: boolean;
  readonly fillWidth?: boolean;
}): React.JSX.Element {
  if (entry.kind === 'tool') {
    return <ToolUseRow toolRow={entry} width={width} />;
  }

  const layout = transcriptEntryLayout(entry, {
    colorEnabled,
    mode: 'scrollback',
    previousEntry,
    width,
  });

  switch (entry.kind) {
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
    case 'log':
      return (
        <Box
          marginBottom={layout.marginBottomRows}
          marginTop={layout.marginTopRows}
        >
          <Markdown
            content={transcriptRowHeadline(entry)}
            width={layout.columns}
            colorEnabled={colorEnabled}
            fillWidth={fillWidth}
          />
        </Box>
      );
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
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly entry: TranscriptRow;
  readonly maxRows: number;
  readonly width?: number;
}): React.JSX.Element {
  if (entry.kind === 'tool') {
    return <ToolUseRow maxRows={maxRows} toolRow={entry} width={width} />;
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
  readonly entry: TranscriptRow;
  readonly width?: number;
}): React.JSX.Element {
  const layout = boundedTranscriptEntryLayout(
    transcriptEntryLayout(entry, { mode: 'live', width }),
    LIVE_TAIL_ROWS,
  );
  return <PlainEntryRows entry={entry} fillWidth layout={layout} />;
});
