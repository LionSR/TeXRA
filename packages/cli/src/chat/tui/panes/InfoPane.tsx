// Third-party imports
import { useLayoutEffect } from 'react';
import { useInput, useWindowSize } from 'ink';

// Local imports - TUI layout, input, and markdown rendering
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { isEscapeInput } from '@cli/tui/inputKeys';
import { FormFrame, formFrameWidth } from '../forms/_shared/FormFrame';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { Markdown } from '../render/Markdown';

const INFO_PANE_FIXED_CHROME_ROWS = 4;
const INFO_PANE_HORIZONTAL_CHROME_COLUMNS = 4;

export function infoPaneRequiredRows(
  title: string,
  lines: readonly string[],
  textWidth: number,
): number {
  const width = Math.max(1, textWidth);
  const titleRows = wrapAnsiToWidth(title, width).split('\n').length;
  const rendered = renderAnsiMarkdown(lines.join('\n'), {
    colorEnabled: false,
    width,
  });
  return INFO_PANE_FIXED_CHROME_ROWS + titleRows + rendered.split('\n').length;
}

export interface InfoPaneProps {
  readonly title: string;
  readonly lines: readonly string[];
  readonly availableRows: number;
  readonly colorEnabled?: boolean;
  readonly onClose: () => void;
  readonly onOverflow: (lines: readonly string[]) => void;
}

/** Stateless, Esc-only reference text surface with a strict row budget. */
export function InfoPane(props: InfoPaneProps): React.JSX.Element | null {
  const { columns } = useWindowSize();
  const textWidth =
    formFrameWidth(columns) - INFO_PANE_HORIZONTAL_CHROME_COLUMNS;
  const fits =
    infoPaneRequiredRows(props.title, props.lines, textWidth) <=
    props.availableRows;

  useInput((input, key) => {
    if (fits && isEscapeInput(input, key)) props.onClose();
  });

  useLayoutEffect(() => {
    // Archive before paint rather than committing an empty foreground frame.
    // The parent clears this pane in the same transition.
    if (!fits) props.onOverflow(props.lines);
  }, [fits, props.lines, props.onOverflow]);

  if (!fits) return null;
  return (
    <FormFrame title={props.title}>
      <Markdown
        colorEnabled={props.colorEnabled}
        content={props.lines.join('\n')}
        width={textWidth}
      />
    </FormFrame>
  );
}
