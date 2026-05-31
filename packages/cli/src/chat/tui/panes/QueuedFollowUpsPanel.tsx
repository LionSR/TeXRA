import { Box, Text } from 'ink';
import stringWidth from 'string-width';

import { collapseWhitespace } from '@utils/text/stringUtils';

export const QUEUED_FOLLOW_UP_PANEL_MAX_ROWS = 3;

export interface QueuedFollowUpPanelRow {
  readonly kind: 'message' | 'overflow';
  readonly text: string;
}

export interface QueuedFollowUpPanelDisplay {
  readonly title: string | undefined;
  readonly rows: readonly QueuedFollowUpPanelRow[];
  readonly hiddenCount: number;
}

function truncateToColumns(text: string, maxColumns: number): string {
  const summary = collapseWhitespace(text);
  if (stringWidth(summary) <= maxColumns) return summary;

  const ellipsis = '…';
  const contentColumns = Math.max(0, maxColumns - stringWidth(ellipsis));
  let width = 0;
  let truncated = '';
  for (const char of summary) {
    const charWidth = stringWidth(char);
    if (width + charWidth > contentColumns) break;
    truncated += char;
    width += charWidth;
  }
  return `${truncated}${ellipsis}`;
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
  const title = truncateToColumns(
    `Queued follow-ups (${messages.length})`,
    contentWidth,
  );
  const messageSlots = Math.max(0, maxRows - 1);
  if (messageSlots === 0) {
    return { title, rows: [], hiddenCount: messages.length };
  }

  const hasOverflow = messages.length > messageSlots;
  const visibleMessageCount = hasOverflow
    ? Math.max(0, messageSlots - 1)
    : Math.min(messages.length, messageSlots);
  const rows: QueuedFollowUpPanelRow[] = messages
    .slice(0, visibleMessageCount)
    .map((message, index) => {
      const prefix = `${index + 1}. `;
      const bodyWidth = Math.max(0, contentWidth - stringWidth(prefix));
      return {
        kind: 'message',
        text: `${prefix}${truncateToColumns(message, bodyWidth)}`,
      };
    });

  const hiddenCount = messages.length - visibleMessageCount;
  if (hiddenCount > 0) {
    rows.push({
      kind: 'overflow',
      text: truncateToColumns(`… ${hiddenCount} more queued`, contentWidth),
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
      <Text color="yellow" wrap="truncate-end">
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
