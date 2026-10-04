// Scrollable, read-only view of one stream's canonical plan.

import { useInput, useWindowSize } from 'ink';

import { type SessionHandle } from '@agent/runtime';
import { isEscapeInput } from '@cli/tui/inputKeys';
import { ReaderPanel, readerLayout } from '@cli/tui/ui/BorderedPanel';
import { CLOSE_HINTS, READER_SCROLL_HINTS } from '@cli/tui/ui/KeyHints';
import { AgentCategory, type RunId } from '@shared/schemas';

import { ScrollableModalText } from '../modals/ScrollableModalText';

export function WorkPlanReader({
  availableRows,
  onClose,
  runId,
  session,
  title,
}: {
  readonly availableRows: number;
  readonly onClose: () => void;
  readonly runId: RunId;
  /** The chat's session the plan is read from, threaded from the App. */
  readonly session: SessionHandle;
  readonly title: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const run = session.runView(runId);
  const plan = run?.category === AgentCategory.ToolUse ? run.plan : null;
  const layout = readerLayout({
    availableRows,
    frameWidth: Math.max(1, columns),
    hints: READER_SCROLL_HINTS,
    title,
  });
  const text = `Objective\n${plan?.objective ?? '(no objective)'}`;

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
