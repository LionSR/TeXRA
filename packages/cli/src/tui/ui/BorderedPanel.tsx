// Shared bordered-panel scaffold used by FormFrame (transient list-form
// states), ConfirmCard (y/n approval modals), UserQuestion's QuestionShell
// and the scrollable readers: a bordered box with a colored bold title, a
// body slot, and an optional footer row. Its geometry lives here, beside the
// box it measures.

import { Box, Text, type BoxProps } from 'ink';

import { wrappedRowCount } from '@cli/tui/ansiWrap';
import { keyHintsText, type KeyHint } from '@cli/tui/ui/KeyHints';
import { COLOR_HINT } from '@cli/tui/ui/colors';

/** Columns the left and right border plus `paddingX` take from `width`. */
export const BORDERED_PANEL_CHROME_COLUMNS = 4;
const BORDER_ROWS = 2;
const FOOTER_MARGIN_ROWS = 1;

/** Rows the border and a `hints` footer (behind its default margin) take at
 *  `contentWidth`, beside the panel's title and body. */
export function borderedPanelChromeRows(
  hints: readonly KeyHint[],
  contentWidth: number,
): number {
  return (
    BORDER_ROWS +
    FOOTER_MARGIN_ROWS +
    wrappedRowCount(keyHintsText(hints), contentWidth)
  );
}

interface BorderedPanelProps {
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
  /** `marginTop` for the footer's wrapper box. Defaults to one row; some
   *  callers collapse it to `0` in their own compact layouts. */
  readonly footerMarginTop?: number;
}

export function BorderedPanel({
  borderStyle = 'round',
  color,
  title,
  width,
  children,
  footer,
  footerMarginTop = FOOTER_MARGIN_ROWS,
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

/**
 * Fit a closable reader panel into `availableRows`: the border first, then
 * the wrapped footer `hints`, then the title, each only while one body row
 * still fits beside it. `extraRows` are fixed rows the reader paints above
 * its scrolled body (a tab strip, a filter line). Under four rows the border
 * goes and one truncated title row stays, and `bodyRows` may be zero.
 */
export function readerLayout({
  availableRows,
  extraRows = 0,
  frameWidth,
  hints,
  title,
}: {
  readonly availableRows: number;
  readonly extraRows?: number;
  readonly frameWidth: number;
  readonly hints: readonly KeyHint[];
  readonly title: string;
}) {
  const rows = Math.max(1, Math.floor(availableRows));
  if (rows < 4) {
    return {
      availableRows: rows,
      bodyRows: Math.max(0, rows - 1 - extraRows),
      contentWidth: frameWidth,
      frameWidth,
      showBorder: false,
      showFooter: false,
      showTitle: true,
    };
  }
  const contentWidth = Math.max(1, frameWidth - BORDERED_PANEL_CHROME_COLUMNS);
  const bareRows = BORDER_ROWS + extraRows;
  const footerRows = borderedPanelChromeRows(hints, contentWidth) - BORDER_ROWS;
  const showFooter = rows >= bareRows + footerRows + 1;
  const fixedRows = bareRows + (showFooter ? footerRows : 0);
  const titleRows = wrappedRowCount(title, contentWidth);
  const showTitle = rows >= fixedRows + titleRows + 1;
  return {
    availableRows: rows,
    bodyRows: Math.max(1, rows - fixedRows - (showTitle ? titleRows : 0)),
    contentWidth,
    frameWidth,
    showBorder: true,
    showFooter,
    showTitle,
  };
}

/** The panel a {@link readerLayout} measured: bordered, with the title and
 *  `footer` it has rows for, or a bare truncated title over the body. */
export function ReaderPanel({
  children,
  footer,
  layout,
  title,
}: {
  readonly children: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly layout: ReturnType<typeof readerLayout>;
  readonly title: string;
}): React.JSX.Element {
  if (!layout.showBorder) {
    return (
      <Box
        flexDirection="column"
        height={layout.availableRows}
        width={layout.frameWidth}
      >
        <Text bold color={COLOR_HINT} wrap="truncate-end">
          {title}
        </Text>
        {children}
      </Box>
    );
  }
  return (
    <BorderedPanel
      color={COLOR_HINT}
      title={layout.showTitle ? title : undefined}
      width={layout.frameWidth}
      footer={layout.showFooter ? footer : undefined}
    >
      {children}
    </BorderedPanel>
  );
}
