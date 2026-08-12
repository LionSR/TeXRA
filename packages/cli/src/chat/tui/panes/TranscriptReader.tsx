// Scrollable, closable full-transcript reader. Ctrl-T's predecessor printed the
// same content straight into terminal scrollback, which the terminal owns and
// nothing can take back. This renders it in the live region instead, so Esc
// restores the conversation exactly as it was. ↑/↓ scrolls line by line;
// PgUp/PgDn pages through the transcript.
//
// The TUI never enters the alternate screen (see tui/terminalCleanup.ts), so a
// full-screen pager is not an option here — this is an ordinary foreground
// surface, sized by the same row budget every other one uses.

import { useMemo } from 'react';
import { useInput, useWindowSize } from 'ink';

import { isEscapeInput } from '@cli/tui/inputKeys';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import { KeyHints, READER_SCROLL_HINTS } from '@cli/tui/ui/KeyHints';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { CONFIRM_CARD_HORIZONTAL_DECORATION } from '@cli/tui/ui/theme';
import type { StreamTabId } from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import { formFrameWidth } from '../forms/_shared/FormFrame';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from '../modals/ScrollableModalText';
import { streams as streamsSignal } from '../state/cliState';
import { transcriptToLines } from '../state/transcriptLines';
import { useSignal } from '../state/useSignal';

const EMPTY_TRANSCRIPT_TEXT = '(no output yet)';

export function transcriptReaderTitle(label: string | undefined): string {
  return label ? `Transcript: ${label}` : 'Transcript';
}

export function TranscriptReader({
  availableRows,
  executionLabels,
  onClose,
  streamId,
  title,
}: {
  readonly availableRows: number;
  readonly executionLabels?: ExecutionLabels;
  readonly onClose: () => void;
  readonly streamId: StreamTabId;
  readonly title: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const streams = useSignal(streamsSignal);
  const slice = streams.get(streamId);
  const frameWidth = formFrameWidth(columns);
  const width = frameWidth - CONFIRM_CARD_HORIZONTAL_DECORATION;

  // Recomputed as the run appends rows, so the reader stays live rather than
  // freezing at the content present when it opened.
  const text = useMemo(() => {
    const body = transcriptToLines(slice, width, executionLabels)
      .join('\n')
      .trimEnd();
    return body || EMPTY_TRANSCRIPT_TEXT;
  }, [executionLabels, slice, width]);

  useInput((input, key) => {
    if (isEscapeInput(input, key)) {
      onClose();
    }
  });

  return (
    <BorderedPanel
      color={COLOR_HINT}
      title={title}
      width={frameWidth}
      footer={<KeyHints hints={READER_SCROLL_HINTS} confirmCancel={false} />}
    >
      <ScrollableModalText
        hiddenNoun="transcript rows"
        maxRows={scrollableModalTextRowsBudget({
          availableRows,
          columns,
          title,
        })}
        preWrapped
        resetKey={streamId}
        scrollHint="scroll transcript"
        showScrollHints={false}
        startAtEnd
        text={text}
        width={width}
      />
    </BorderedPanel>
  );
}
