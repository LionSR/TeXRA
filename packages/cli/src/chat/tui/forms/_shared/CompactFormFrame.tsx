import { Box, Text } from 'ink';

import { KeyHints, type KeyHint } from '@cli/chat/tui/ui/KeyHints';

// Six foreground rows is the smallest budget that can keep a compact form's
// title, context, selectable row(s), and key hints visible. With the current
// pinned TUI chrome, that covers terminals around 12-13 rows tall.
export const COMPACT_FORM_MAX_ROWS = 6;

export function shouldUseCompactForm(
  availableRows: number | undefined,
): boolean {
  return availableRows != null && availableRows <= COMPACT_FORM_MAX_ROWS;
}

export interface CompactFormFrameProps {
  readonly title: string;
  readonly description?: string;
  readonly color?: string;
  readonly children: React.ReactNode;
  readonly hints: readonly KeyHint[];
  readonly confirmCancel?: boolean;
}

export function CompactFormFrame(
  props: CompactFormFrameProps,
): React.JSX.Element {
  return (
    <Box flexDirection="column" minWidth={0}>
      <Text bold color={props.color ?? 'cyan'} wrap="truncate-end">
        {props.title}
      </Text>
      {props.description ? (
        <Text dimColor wrap="truncate-end">
          {props.description}
        </Text>
      ) : null}
      {props.children}
      <KeyHints hints={props.hints} confirmCancel={props.confirmCancel} />
    </Box>
  );
}
