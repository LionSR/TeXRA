// Shared bordered-panel scaffold used by FormFrame (transient list-form
// states) and ConfirmCard (y/n approval modals): a bordered box with a
// colored bold title, a body slot, and an optional footer row.

import { Box, Text, type BoxProps } from 'ink';

export interface BorderedPanelProps {
  readonly borderStyle?: BoxProps['borderStyle'];
  readonly color: string;
  readonly title: string;
  readonly width?: number;
  readonly children: React.ReactNode;
  /** Rendered inside its own `marginTop={1}` box (typically `<KeyHints>`).
   *  Omit (or pass a falsy value) to render no footer row. */
  readonly footer?: React.ReactNode;
}

export function BorderedPanel({
  borderStyle = 'round',
  color,
  title,
  width,
  children,
  footer,
}: BorderedPanelProps): React.JSX.Element {
  return (
    <Box
      borderStyle={borderStyle}
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      width={width}
    >
      <Text bold color={color}>
        {title}
      </Text>
      {children}
      {footer ? <Box marginTop={1}>{footer}</Box> : null}
    </Box>
  );
}
