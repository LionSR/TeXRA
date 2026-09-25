// Per-entry Ink presentation. Geometry and text rows come from
// transcriptEntryLayout; this module adds only role-specific styling and rich
// widgets.

// Third-party imports
import { memo } from 'react';
import { Box, Text } from 'ink';
import { COLOR_ERROR, COLOR_HINT } from '@cli/tui/ui/colors';
import { fillRows } from '@cli/runtime/terminalText';
import type { TranscriptRow } from '@ui/transcript';

// Local imports - CLI TUI rendering
import { Markdown } from '../render/Markdown';
import { ToolUseRow } from './ToolUseRow';
import {
  COMPACTION_ACTIVITY_STATUS_STYLE,
  WORKFLOW_TASK_STATUS_COLOR,
  boundedTranscriptEntryLayout,
  transcriptEntryLayout,
  type TranscriptEntryLayout,
} from './transcriptEntryLayout';
import {
  isInquiryContinuationText,
  transcriptRowHeadline,
} from './transcriptEntries';

function PlainEntryRows({
  entry,
  fillWidth,
  layout,
}: {
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
            color={index === 0 ? COLOR_HINT : undefined}
            dimColor={index > 0}
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
  } else if (entry.kind === 'compactionActivity') {
    rowColor = COMPACTION_ACTIVITY_STATUS_STYLE[entry.block.status].color;
  } else if (entry.kind === 'workflowTask') {
    rowColor = WORKFLOW_TASK_STATUS_COLOR[entry.call.status];
  } else if (entry.kind === 'phase') {
    rowColor = COLOR_HINT;
  }

  return (
    <Box {...boxProps}>
      <Text
        bold={entry.kind === 'phase'}
        color={rowColor}
        inverse={entry.kind === 'user'}
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
}: {
  readonly entry: TranscriptRow;
  /** The row printed directly above this one, so its bottom separator can
   *  absorb this row's top one. Yoga does not collapse margins. */
  readonly previousEntry?: TranscriptRow;
  readonly width?: number;
}): React.JSX.Element {
  if (entry.kind === 'tool') {
    return <ToolUseRow toolRow={entry} width={width} />;
  }

  const layout = transcriptEntryLayout(entry, {
    mode: 'scrollback',
    previousEntry,
    width,
  });

  switch (entry.kind) {
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
          />
        </Box>
      );
    default:
      return <PlainEntryRows entry={entry} layout={layout} />;
  }
});

export const LiveTranscriptEntry = memo(function LiveTranscriptEntry({
  entry,
  maxRows,
  width,
}: {
  readonly entry: TranscriptRow;
  readonly maxRows?: number;
  readonly width?: number;
}): React.JSX.Element {
  if (entry.kind === 'tool') {
    return <ToolUseRow maxRows={maxRows} toolRow={entry} width={width} />;
  }

  // Paint every live row from the same layout the viewport measures. A
  // separate kind switch in the pane can reserve space for rows it omits.
  const layout = transcriptEntryLayout(entry, { mode: 'live', width });
  return (
    <PlainEntryRows
      entry={entry}
      fillWidth
      layout={
        maxRows === undefined
          ? layout
          : boundedTranscriptEntryLayout(layout, maxRows)
      }
    />
  );
});
