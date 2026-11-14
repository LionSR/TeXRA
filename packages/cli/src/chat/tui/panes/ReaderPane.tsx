// Scrollable, closable readers over one run: its full transcript (Ctrl-T) and
// its plan. Ctrl-T's predecessor printed the transcript straight into terminal
// scrollback, which the terminal owns and nothing can take back. A reader
// renders in the live region instead, so Esc restores the conversation exactly
// as it was. ↑/↓ scrolls line by line; PgUp/PgDn pages.
//
// The TUI never enters the alternate screen (see tui/terminalCleanup.ts), so a
// full-screen pager is not an option here, this is an ordinary foreground
// surface, sized by the same row budget every other one uses.

import { useCallback, useMemo } from 'react';
import { useInput, useWindowSize } from 'ink';

import {
  planOf,
  type RunId,
  type TranscriptView,
} from '@texra-ai/harness/schemas';
import { isEscapeInput } from '@cli/tui/inputKeys';
import { ReaderPanel, readerLayout } from '@cli/tui/ui/BorderedPanel';
import { CLOSE_HINTS, READER_SCROLL_HINTS } from '@cli/tui/ui/KeyHints';

import { ScrollableModalText } from '../modals/ScrollableModalText';
import { sessionView, runViewOf } from '../state/sessionView';
import { transcriptToLines } from '../state/transcriptLines';
import { useSignal } from '../state/useSignal';

const EMPTY_TRANSCRIPT_TEXT = '(no output yet)';
const EMPTY_TRANSCRIPT: Pick<TranscriptView, 'rows'> = { rows: [] };

interface ReaderProps {
  readonly availableRows: number;
  readonly onClose: () => void;
  readonly runId: RunId;
  readonly title: string;
}

/** The pane both readers render: `text` at the pane's content width. */
function ReaderPane({
  availableRows,
  onClose,
  runId,
  title,
  hiddenNoun,
  text,
  laidOut = false,
}: ReaderProps & {
  readonly hiddenNoun: string;
  /** The text at a content width; a new function is new content. */
  readonly text: (width: number) => string;
  /** `text` is already wrapped to the width and grows at its end, so the
   *  pane wraps nothing and opens at the bottom. */
  readonly laidOut?: boolean;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const layout = readerLayout({
    availableRows,
    frameWidth: Math.max(1, columns),
    hints: READER_SCROLL_HINTS,
    title,
  });
  const width = layout.contentWidth;
  const body = useMemo(() => text(width), [text, width]);

  useInput((input, key) => {
    if (isEscapeInput(input, key)) onClose();
  });

  return (
    <ReaderPanel layout={layout} title={title}>
      {layout.bodyRows > 0 ? (
        <ScrollableModalText
          footerHints={layout.showFooter ? CLOSE_HINTS : undefined}
          hiddenNoun={hiddenNoun}
          marginWhenSpacious={false}
          maxRows={layout.bodyRows}
          minContentWidth={1}
          preWrapped={laidOut}
          resetKey={runId}
          scrollHint="scroll"
          showScrollHints={false}
          startAtEnd={laidOut}
          text={body}
          width={width}
        />
      ) : null}
    </ReaderPanel>
  );
}

/** A run's full transcript, live while the reader is open. */
export function TranscriptReader(props: ReaderProps): React.JSX.Element {
  const view = useSignal(sessionView());
  // The transcript value, never its `rows` array: the session view appends and
  // patches rows in place and replaces the transcript on every change (a
  // new row, a patched row, a text chunk), so the transcript is the
  // identity the text below keys on to stay live while the reader is open.
  const transcript =
    runViewOf(view, props.runId)?.transcript ?? EMPTY_TRANSCRIPT;
  const text = useCallback(
    (width: number) =>
      transcriptToLines(transcript.rows, width).join('\n').trimEnd() ||
      EMPTY_TRANSCRIPT_TEXT,
    [transcript],
  );
  return (
    <ReaderPane {...props} hiddenNoun="transcript rows" laidOut text={text} />
  );
}

/** A run's plan as the view the chat renders states it, live. */
export function WorkPlanReader(props: ReaderProps): React.JSX.Element {
  const run = useSignal(sessionView()).runs.get(props.runId);
  const objective = (run ? planOf(run) : null)?.objective ?? '(no objective)';
  const text = useCallback(() => `Objective\n${objective}`, [objective]);
  return <ReaderPane {...props} hiddenNoun="work plan rows" text={text} />;
}
