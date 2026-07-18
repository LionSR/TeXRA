// Third-party imports
import { useEffect } from 'react';
import { useInput, useWindowSize } from 'ink';

// Local imports - TUI layout, input, and markdown rendering
import { FormFrame, formFrameWidth } from '../forms/_shared/FormFrame';
import { isEscapeInput } from '../input/inputKeys';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { Markdown } from '../render/Markdown';

const INFO_PANE_CHROME_ROWS = 5;
const INFO_PANE_HORIZONTAL_CHROME_COLUMNS = 4;

export function infoPaneRequiredRows(
  lines: readonly string[],
  textWidth: number,
): number {
  const width = Math.max(1, textWidth);
  const rendered = renderAnsiMarkdown(lines.join('\n'), {
    colorEnabled: false,
    width,
  });
  return INFO_PANE_CHROME_ROWS + rendered.split('\n').length;
}

export interface InfoPaneProps {
  readonly title: string;
  readonly lines: readonly string[];
  readonly availableRows: number;
  readonly onClose: () => void;
  readonly onOverflow: () => void;
}

/** Stateless, Esc-only reference text surface with a strict row budget. */
export function InfoPane(props: InfoPaneProps): React.JSX.Element | null {
  const { columns } = useWindowSize();
  const textWidth =
    formFrameWidth(columns) - INFO_PANE_HORIZONTAL_CHROME_COLUMNS;
  const fits =
    infoPaneRequiredRows(props.lines, textWidth) <= props.availableRows;

  useInput((input, key) => {
    if (fits && isEscapeInput(input, key)) props.onClose();
  });

  useEffect(() => {
    // Archive after rendering rather than mutating transcript/signal state in
    // the render path. The parent clears this pane in the same transition.
    if (!fits) props.onOverflow();
  }, [fits, props.lines, props.onOverflow]);

  if (!fits) return null;
  return (
    <FormFrame title={props.title}>
      <Markdown content={props.lines.join('\n')} width={textWidth} />
    </FormFrame>
  );
}
