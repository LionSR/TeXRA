// Third-party imports
import { useLayoutEffect } from 'react';
import { useInput, useWindowSize } from 'ink';

// Local imports - TUI layout, input, and markdown rendering
import { wrappedRowCount } from '@cli/tui/ansiWrap';
import { isEscapeInput } from '@cli/tui/inputKeys';
import { borderedPanelChromeRows } from '@cli/tui/ui/BorderedPanel';
import { CLOSE_HINTS } from '@cli/tui/ui/KeyHints';
import { FormFrame, formFrameContentWidth } from '../forms/_shared/FormFrame';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { Markdown } from '../render/Markdown';

function infoPaneRequiredRows(
  title: string,
  lines: readonly string[],
  width: number,
): number {
  const titleRows = wrappedRowCount(title, width);
  const rendered = renderAnsiMarkdown(lines.join('\n'), {
    colorEnabled: false,
    width,
  });
  return (
    borderedPanelChromeRows(CLOSE_HINTS, width) +
    titleRows +
    rendered.split('\n').length
  );
}

interface InfoPaneProps {
  readonly title: string;
  readonly lines: readonly string[];
  readonly availableRows: number;
  readonly onClose: () => void;
  readonly onOverflow: (lines: readonly string[]) => void;
}

/** Stateless, Esc-only reference text surface with a strict row budget. */
export function InfoPane(props: InfoPaneProps): React.JSX.Element | null {
  const { columns } = useWindowSize();
  const textWidth = formFrameContentWidth(columns);
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
      <Markdown content={props.lines.join('\n')} width={textWidth} />
    </FormFrame>
  );
}
