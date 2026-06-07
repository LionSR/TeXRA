// Shared rounded panel used by `/`-form transient states (loading, error, and
// empty). Replaces the per-form `XFrame` wrappers that all rendered the same
// bordered column with a colored title and an `Esc close` footer.

import { Box, Text, useWindowSize } from 'ink';

import { KeyHints, type KeyHint } from '@cli/chat/tui/ui/KeyHints';

export interface FormFrameProps {
  readonly color: string;
  readonly title: string;
  readonly children: React.ReactNode;
  /**
   * Append the canonical `Esc close` footer. Forms whose transient states
   * carry their own footer (or none, like `/tools`) pass `false`.
   */
  readonly showCloseHint?: boolean;
}

const FORM_FRAME_MAX_WIDTH = 80;

export function formFrameWidth(columns: number | undefined): number {
  const normalized =
    columns != null && Number.isFinite(columns) && columns > 0
      ? Math.floor(columns)
      : FORM_FRAME_MAX_WIDTH;
  return Math.max(1, Math.min(normalized, FORM_FRAME_MAX_WIDTH));
}

export function FormFrame(props: FormFrameProps): React.JSX.Element {
  const { columns } = useWindowSize();

  return (
    <Box
      borderStyle="round"
      borderColor={props.color}
      flexDirection="column"
      paddingX={1}
      width={formFrameWidth(columns)}
    >
      <Text bold color={props.color}>
        {props.title}
      </Text>
      {props.children}
      {props.showCloseHint === false ? null : (
        <Box marginTop={1}>
          <KeyHints
            hints={[{ key: 'Esc', action: 'close' }]}
            confirmCancel={false}
          />
        </Box>
      )}
    </Box>
  );
}

export function CompactFormKeyHints(props: {
  readonly primary: KeyHint;
  readonly escapeAction?: string;
}): React.JSX.Element {
  return (
    <KeyHints
      hints={[
        { key: '↑/↓', action: 'navigate' },
        props.primary,
        { key: 'Esc', action: props.escapeAction ?? 'close' },
      ]}
      confirmCancel={false}
    />
  );
}
