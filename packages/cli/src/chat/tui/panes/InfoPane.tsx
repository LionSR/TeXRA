import { useEffect } from 'react';
import { Text, useInput, useWindowSize } from 'ink';

import { isEscapeInput } from '../input/inputKeys';
import { textDisplayWidth } from '../render/terminalText';
import { FormFrame, formFrameWidth } from '../forms/_shared/FormFrame';

const INFO_PANE_CHROME_ROWS = 5;
const INFO_PANE_HORIZONTAL_CHROME_COLUMNS = 4;

export function infoPaneRequiredRows(
  lines: readonly string[],
  textWidth: number,
): number {
  const width = Math.max(1, textWidth);
  return (
    INFO_PANE_CHROME_ROWS +
    lines.reduce(
      (rows, line) =>
        rows + Math.max(1, Math.ceil(textDisplayWidth(line) / width)),
      0,
    )
  );
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
  }, [fits, props.onOverflow]);

  if (!fits) return null;
  return (
    <FormFrame title={props.title}>
      <Text wrap="wrap">{props.lines.join('\n')}</Text>
    </FormFrame>
  );
}
