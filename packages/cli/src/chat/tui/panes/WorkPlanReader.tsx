// Scrollable, read-only view of one stream's canonical plan.

import { useInput, useWindowSize } from 'ink';

import { isEscapeInput } from '@cli/tui/inputKeys';
import { ReaderPanel, readerLayout } from '@cli/tui/ui/BorderedPanel';
import { CLOSE_HINTS, READER_SCROLL_HINTS } from '@cli/tui/ui/KeyHints';
import { ScrollableModalText } from '../modals/ScrollableModalText';
import { sessionView } from '../state/sessionView';
import { useSignal } from '../state/useSignal';
import type { RunId } from '@texra-ai/harness/schemas';

export function WorkPlanReader({
  availableRows,
  onClose,
  runId,
  title,
}: {
  readonly availableRows: number;
  readonly onClose: () => void;
  readonly runId: RunId;
  readonly title: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  // The plan as the view the chat renders states it, live.
  const run = useSignal(sessionView()).runs.get(runId);
  const layout = readerLayout({
    availableRows,
    frameWidth: Math.max(1, columns),
    hints: READER_SCROLL_HINTS,
    title,
  });
  const text = `Objective\n${run?.plan?.objective ?? '(no objective)'}`;

  useInput((input, key) => {
    if (isEscapeInput(input, key)) onClose();
  });

  return (
    <ReaderPanel layout={layout} title={title}>
      {layout.bodyRows > 0 ? (
        <ScrollableModalText
          footerHints={layout.showFooter ? CLOSE_HINTS : undefined}
          hiddenNoun="work plan rows"
          marginWhenSpacious={false}
          maxRows={layout.bodyRows}
          minContentWidth={1}
          resetKey={runId}
          scrollHint="scroll"
          showScrollHints={false}
          text={text}
          width={layout.contentWidth}
        />
      ) : null}
    </ReaderPanel>
  );
}
