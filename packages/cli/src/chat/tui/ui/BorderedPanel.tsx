// Shared bordered-panel scaffold used by FormFrame (transient list-form
// states), ConfirmCard (y/n approval modals), ExternalInquiry and
// UserQuestion's QuestionShell: a bordered box with a colored bold title, a
// body slot, and an optional footer row.

import { Box, Text, type BoxProps } from 'ink';

export interface BorderedPanelProps {
  readonly borderStyle?: BoxProps['borderStyle'];
  readonly color: string;
  /** Omit (or pass a falsy value) to render no title row — callers drop the
   *  title once the viewport gets too short for it. */
  readonly title?: React.ReactNode;
  readonly width?: number;
  readonly children: React.ReactNode;
  /** Rendered inside its own margin box (typically `<KeyHints>`).
   *  Omit (or pass a falsy value) to render no footer row. */
  readonly footer?: React.ReactNode;
  /** `marginTop` for the footer's wrapper box. Defaults to `1`; some callers
   *  collapse it to `0` in their own compact layouts. */
  readonly footerMarginTop?: number;
}

export function BorderedPanel({
  borderStyle = 'round',
  color,
  title,
  width,
  children,
  footer,
  footerMarginTop = 1,
}: BorderedPanelProps): React.JSX.Element {
  return (
    <Box
      borderStyle={borderStyle}
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      width={width}
    >
      {title ? (
        <Text bold color={color}>
          {title}
        </Text>
      ) : null}
      {children}
      {footer ? <Box marginTop={footerMarginTop}>{footer}</Box> : null}
    </Box>
  );
}
