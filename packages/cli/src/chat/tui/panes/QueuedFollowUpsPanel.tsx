import { Box, Text } from 'ink';

import { hiddenRowsText } from '@cli/tui/overflowText';
import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { summarizeFollowupMessage } from '@shared/subagentFollowup';
import { pluralize } from '@utils/text/stringUtils';

import {
  textDisplayWidth,
  truncateSummaryToWidth,
} from '../render/terminalText';

const QUEUED_FOLLOW_UP_PANEL_MAX_ROWS = 3;

interface QueuedFollowUpPanelRow {
  readonly kind: 'message' | 'overflow';
  readonly text: string;
}

export interface QueuedFollowUpPanelDisplay {
  readonly title: string | undefined;
  readonly rows: readonly QueuedFollowUpPanelRow[];
  readonly hiddenCount: number;
}

export function queuedFollowUpPanelRowCount(
  messages: readonly string[],
): number {
  if (messages.length === 0) return 0;
  return Math.min(QUEUED_FOLLOW_UP_PANEL_MAX_ROWS, messages.length + 1);
}

export function queuedFollowUpPanelDisplay({
  maxRows,
  messages,
  width,
}: {
  readonly maxRows: number;
  readonly messages: readonly string[];
  readonly width: number;
}): QueuedFollowUpPanelDisplay {
  if (messages.length === 0 || maxRows <= 0) {
    return { title: undefined, rows: [], hiddenCount: 0 };
  }

  const contentWidth = Math.max(0, width - 2);
  const title = truncateSummaryToWidth(
    `Queued follow-ups (${messages.length})`,
    contentWidth,
  );
  const messageSlots = Math.max(0, maxRows - 1);
  if (messageSlots === 0) {
    return { title, rows: [], hiddenCount: messages.length };
  }

  const hasOverflow = messages.length > messageSlots;
  // On overflow, reserve the last slot for the hidden-count row.
  const visibleMessageCount = hasOverflow
    ? Math.max(0, messageSlots - 1)
    : messages.length;
  const rows: QueuedFollowUpPanelRow[] = messages
    .slice(0, visibleMessageCount)
    .map((message, index) => {
      const prefix = `${index + 1}. `;
      const bodyColumns = Math.max(0, contentWidth - textDisplayWidth(prefix));
      return {
        kind: 'message',
        text: `${prefix}${truncateSummaryToWidth(
          summarizeFollowupMessage(message),
          bodyColumns,
        )}`,
      };
    });

  const hiddenCount = messages.length - visibleMessageCount;
  if (hiddenCount > 0) {
    rows.push({
      kind: 'overflow',
      text: truncateSummaryToWidth(
        hiddenRowsText(
          hiddenCount,
          pluralize(hiddenCount, 'queued follow-up', 'queued follow-ups'),
        ),
        contentWidth,
      ),
    });
  }

  return { title, rows, hiddenCount };
}

export function QueuedFollowUpsPanel({
  maxRows,
  messages,
  width,
}: {
  readonly maxRows: number;
  readonly messages: readonly string[];
  readonly width: number;
}): React.JSX.Element | null {
  const display = queuedFollowUpPanelDisplay({ maxRows, messages, width });
  if (!display.title) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={COLOR_WARNING} wrap="truncate-end">
        {display.title}
      </Text>
      {display.rows.map((row, index) => (
        <Text
          key={`${row.kind}-${index}`}
          dimColor={row.kind === 'overflow'}
          wrap="truncate-end"
        >
          {row.text}
        </Text>
      ))}
    </Box>
  );
}
