import { Box, Text } from 'ink';

import { hiddenRowsText } from '@cli/tui/overflowText';
import { COLOR_WARNING } from '@cli/tui/ui/colors';
import {
  textDisplayWidth,
  truncateSummaryToWidth,
} from '@cli/runtime/terminal/terminalText';
import { pluralize, type RunView } from '@texra-ai/worldline/schemas';
import { queuedMessagesTitle } from '@ui/copy/queuedMessages';

const QUEUED_FOLLOW_UP_PANEL_MAX_ROWS = 3;

type QueuedFollowUps = RunView['queuedFollowUps'];

interface QueuedFollowUpPanelRow {
  /** The follow-up's own id; the overflow row's is `overflow`. */
  readonly key: string;
  readonly kind: 'message' | 'overflow';
  readonly text: string;
}

interface QueuedFollowUpPanelDisplay {
  readonly title: string | undefined;
  readonly rows: readonly QueuedFollowUpPanelRow[];
}

export function queuedFollowUpPanelRowCount(
  followUps: QueuedFollowUps,
): number {
  if (followUps.length === 0) return 0;
  return Math.min(QUEUED_FOLLOW_UP_PANEL_MAX_ROWS, followUps.length + 1);
}

function queuedFollowUpPanelDisplay({
  maxRows,
  followUps,
  width,
}: {
  readonly maxRows: number;
  readonly followUps: QueuedFollowUps;
  readonly width: number;
}): QueuedFollowUpPanelDisplay {
  if (followUps.length === 0 || maxRows <= 0) {
    return { title: undefined, rows: [] };
  }

  const contentWidth = Math.max(0, width - 2);
  const title = truncateSummaryToWidth(
    queuedMessagesTitle(followUps.length),
    contentWidth,
  );
  const messageSlots = Math.max(0, maxRows - 1);
  if (messageSlots === 0) {
    return { title, rows: [] };
  }

  const hasOverflow = followUps.length > messageSlots;
  // On overflow, reserve the last slot for the hidden-count row.
  const visibleMessageCount = hasOverflow ? messageSlots - 1 : followUps.length;
  const rows: QueuedFollowUpPanelRow[] = followUps
    .slice(0, visibleMessageCount)
    .map(({ followUpId, text }, index) => {
      const prefix = `${index + 1}. `;
      const bodyColumns = Math.max(0, contentWidth - textDisplayWidth(prefix));
      return {
        key: followUpId,
        kind: 'message',
        text: `${prefix}${truncateSummaryToWidth(text, bodyColumns)}`,
      };
    });

  const hiddenCount = followUps.length - visibleMessageCount;
  if (hiddenCount > 0) {
    rows.push({
      key: 'overflow',
      kind: 'overflow',
      text: truncateSummaryToWidth(
        hiddenRowsText(hiddenCount, pluralize(hiddenCount, 'queued message')),
        contentWidth,
      ),
    });
  }

  return { title, rows };
}

export function QueuedFollowUpsPanel({
  maxRows,
  followUps,
  width,
}: {
  readonly maxRows: number;
  readonly followUps: QueuedFollowUps;
  readonly width: number;
}): React.JSX.Element | null {
  const display = queuedFollowUpPanelDisplay({ maxRows, followUps, width });
  if (!display.title) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={COLOR_WARNING} wrap="truncate-end">
        {display.title}
      </Text>
      {display.rows.map((row) => (
        <Text
          key={row.key}
          dimColor={row.kind === 'overflow'}
          wrap="truncate-end"
        >
          {row.text}
        </Text>
      ))}
    </Box>
  );
}
