// Scrollable, closable full-transcript reader. Ctrl-T's predecessor printed the
// same content straight into terminal scrollback, which the terminal owns and
// nothing can take back. This renders it in the live region instead, so Esc
// restores the conversation exactly as it was. ↑/↓ scrolls line by line;
// PgUp/PgDn pages through the transcript.
//
// The TUI never enters the alternate screen (see tui/terminalCleanup.ts), so a
// full-screen pager is not an option here, this is an ordinary foreground
// surface, sized by the same row budget every other one uses.

import { useMemo } from 'react';
import { useInput, useWindowSize } from 'ink';

import { isEscapeInput } from '@cli/tui/inputKeys';
import { ReaderPanel, readerLayout } from '@cli/tui/ui/BorderedPanel';
import { CLOSE_HINTS, READER_SCROLL_HINTS } from '@cli/tui/ui/KeyHints';
import type { RunId } from '@shared/schemas';
import type { TranscriptView } from '@shared/session/sessionView';

import { formFrameWidth } from '../forms/_shared/FormFrame';
import { ScrollableModalText } from '../modals/ScrollableModalText';
import { sessionView, runViewOf } from '../state/sessionView';
import { transcriptToLines } from '../state/transcriptLines';
import { useSignal } from '../state/useSignal';
const EMPTY_TRANSCRIPT_TEXT = '(no output yet)';
const EMPTY_TRANSCRIPT: Pick<TranscriptView, 'rows'> = { rows: [] };

export function TranscriptReader({
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
  const view = useSignal(sessionView());
  // The transcript value, never its `rows` array: the fold appends and
  // patches rows in place and replaces the transcript on every change (a
  // new row, a patched row, a text chunk), so the transcript is the
  // identity the effect and memos below key on to stay live while the
  // reader is open.
  const transcript = runViewOf(view, runId)?.transcript ?? EMPTY_TRANSCRIPT;
  const layout = readerLayout({
    availableRows,
    frameWidth: formFrameWidth(columns),
    hints: READER_SCROLL_HINTS,
    title,
  });
  const width = layout.contentWidth;
  // Recomputed as the run appends rows, so the reader stays live rather than
  // freezing at the content present when it opened.
  const text = useMemo(() => {
    const body = transcriptToLines(transcript.rows, width).join('\n').trimEnd();
    return body || EMPTY_TRANSCRIPT_TEXT;
  }, [transcript, width]);

  useInput((input, key) => {
    if (isEscapeInput(input, key)) {
      onClose();
    }
  });

  return (
    <ReaderPanel layout={layout} title={title}>
      {layout.bodyRows > 0 ? (
        <ScrollableModalText
          footerHints={layout.showFooter ? CLOSE_HINTS : undefined}
          hiddenNoun="transcript rows"
          marginWhenSpacious={false}
          maxRows={layout.bodyRows}
          minContentWidth={1}
          preWrapped
          resetKey={runId}
          scrollHint="scroll"
          showScrollHints={false}
          startAtEnd
          text={text}
          width={width}
        />
      ) : null}
    </ReaderPanel>
  );
}
