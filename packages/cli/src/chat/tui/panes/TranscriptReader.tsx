// Scrollable, closable full-transcript reader. Ctrl-T's predecessor printed the
// same content straight into terminal scrollback, which the terminal owns and
// nothing can take back. This renders it in the live region instead, so Esc
// restores the conversation exactly as it was. ↑/↓ scrolls line by line;
// PgUp/PgDn pages through the transcript.
//
// The TUI never enters the alternate screen (see tui/terminalCleanup.ts), so a
// full-screen pager is not an option here — this is an ordinary foreground
// surface, sized by the same row budget every other one uses.

import { useEffect, useMemo, useState } from 'react';
import { useInput, useWindowSize } from 'ink';

import { isEscapeInput } from '@cli/tui/inputKeys';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import { KeyHints, READER_SCROLL_HINTS } from '@cli/tui/ui/KeyHints';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { CONFIRM_CARD_HORIZONTAL_DECORATION } from '@cli/tui/ui/theme';
import type { StreamTabId } from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { readTranscriptSpill } from '@transcript';

import { formFrameWidth } from '../forms/_shared/FormFrame';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from '../modals/ScrollableModalText';
import {
  streams as streamsSignal,
  type ConversationEntry,
  type StreamSlice,
} from '../state/cliState';
import { transcriptToLines } from '../state/transcriptLines';
import { useSignal } from '../state/useSignal';

const EMPTY_TRANSCRIPT_TEXT = '(no output yet)';
const MISSING_SPILL_TEXT =
  '[Full output is unavailable because this run artifact was deleted.]';

function hydratedTranscript(
  slice: StreamSlice | undefined,
  spills: ReadonlyMap<string, string>,
): StreamSlice | undefined {
  if (!slice || spills.size === 0) return slice;
  const entries = slice.entries.map((entry): ConversationEntry => {
    const spill = entry.spillPath ? spills.get(entry.spillPath) : undefined;
    if (spill === undefined) return entry;
    if (entry.role === 'tool') {
      return { ...entry, toolUse: { ...entry.toolUse, outputText: spill } };
    }
    return { ...entry, text: spill };
  });
  return { ...slice, entries };
}

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
  const [spills, setSpills] = useState<ReadonlyMap<string, string>>(new Map());

  const spillPaths = useMemo(
    () => [
      ...new Set(
        slice?.entries.flatMap((entry) => entry.spillPath ?? []) ?? [],
      ),
    ],
    [slice],
  );

  useEffect(() => {
    let disposed = false;
    void Promise.all(
      spillPaths.map(
        async (spillPath) =>
          [
            spillPath,
            (await readTranscriptSpill(spillPath).catch(() => undefined)) ??
              MISSING_SPILL_TEXT,
          ] as const,
      ),
    ).then((resolved) => {
      if (!disposed) setSpills(new Map(resolved));
    });
    return () => {
      disposed = true;
    };
  }, [spillPaths]);

  const hydratedSlice = useMemo(
    () => hydratedTranscript(slice, spills),
    [slice, spills],
  );

  // Recomputed as the run appends rows, so the reader stays live rather than
  // freezing at the content present when it opened.
  const text = useMemo(() => {
    const body = transcriptToLines(hydratedSlice, width, executionLabels)
      .join('\n')
      .trimEnd();
    return body || EMPTY_TRANSCRIPT_TEXT;
  }, [executionLabels, hydratedSlice, width]);

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
