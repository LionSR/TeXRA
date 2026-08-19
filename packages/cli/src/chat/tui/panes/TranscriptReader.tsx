// Scrollable, closable full-transcript reader. Ctrl-T's predecessor printed the
// same content straight into terminal scrollback, which the terminal owns and
// nothing can take back. This renders it in the live region instead, so Esc
// restores the conversation exactly as it was. ↑/↓ scrolls line by line;
// PgUp/PgDn pages through the transcript.
//
// The TUI never enters the alternate screen (see tui/terminalCleanup.ts), so a
// full-screen pager is not an option here — this is an ordinary foreground
// surface, sized by the same row budget every other one uses.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInput, useWindowSize } from 'ink';

import { tryDefaultSession } from '@agent/runtime';
import { safeTerminalText } from '@cli/runtime/terminalText';
import { isEscapeInput } from '@cli/tui/inputKeys';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import { KeyHints, READER_SCROLL_HINTS } from '@cli/tui/ui/KeyHints';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { CONFIRM_CARD_HORIZONTAL_DECORATION } from '@cli/tui/ui/theme';
import type { StreamTabId } from '@shared/schemas';
import { transcriptText, type TranscriptRow } from '@shared/transcript';
import { readTranscriptSpill } from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { formFrameWidth } from '../forms/_shared/FormFrame';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from '../modals/ScrollableModalText';
import { normalizeKnownHtmlForCliMarkdown } from '../render/htmlMarkdownNormalize';
import { streams as streamsSignal, type StreamSlice } from '../state/cliState';
import { transcriptToLines } from '../state/transcriptLines';
import { useSignal } from '../state/useSignal';
import {
  transcriptRowHeadline,
  trimAssistantTranscriptLead,
} from './transcriptEntries';

const EMPTY_TRANSCRIPT_TEXT = '(no output yet)';
const MISSING_SPILL_TEXT =
  '[Full output is unavailable because this run artifact was deleted.]';

type SpillHydration =
  | { readonly kind: 'loaded'; readonly text: string }
  | { readonly kind: 'failed'; readonly notice: string };

const EMPTY_SPILL_HYDRATIONS: ReadonlyMap<string, SpillHydration> = new Map();

function spillFailureNotice(verb: string, error: unknown): string {
  return `[Unable to ${verb} full output. Close and reopen the transcript to retry: ${toErrorMessage(error)}]`;
}

async function loadSpill(
  spillPath: string,
  flushError: unknown,
): Promise<SpillHydration> {
  try {
    const text = await readTranscriptSpill(spillPath);
    if (text !== undefined) return { kind: 'loaded', text };
    return flushError === undefined
      ? { kind: 'failed', notice: MISSING_SPILL_TEXT }
      : { kind: 'failed', notice: spillFailureNotice('prepare', flushError) };
  } catch (error) {
    return { kind: 'failed', notice: spillFailureNotice('read', error) };
  }
}

function withSpillNotice(preview: string, notice: string): string {
  return preview ? `${preview}\n\n${notice}` : notice;
}

export function hydratedTranscript(
  slice: StreamSlice | undefined,
  spills: ReadonlyMap<string, SpillHydration>,
): StreamSlice | undefined {
  if (!slice) return slice;
  const entries = slice.entries.map((row): TranscriptRow => {
    if (!row.spillPath) return row;
    const spill = spills.get(row.spillPath);
    if (spill === undefined) return { ...row, spillPath: undefined };
    if (row.kind === 'tool') {
      // The row's `model` is untouched: it owns the display *policy* (which
      // blocks show, and why), which the recovery does not change.
      return {
        ...row,
        ...(spill.kind === 'failed' ? { spillFailed: true } : {}),
        toolUse: {
          ...row.toolUse,
          outputText:
            spill.kind === 'loaded'
              ? spill.text
              : withSpillNotice(row.toolUse.outputText, spill.notice),
        },
      };
    }
    const recovered =
      spill.kind === 'loaded'
        ? safeTerminalText(
            normalizeKnownHtmlForCliMarkdown(
              trimAssistantTranscriptLead(spill.text),
            ),
          )
        : withSpillNotice(transcriptRowHeadline(row), spill.notice);
    return hydrateRowHeadline(row, recovered, spill.kind === 'failed');
  });
  return { ...slice, entries };
}

/**
 * Substitute a row's headline text with the recovered artifact. Only the
 * text-bearing kinds can carry a spill artifact in the first place; anything
 * else keeps its own payload and only records that the read failed.
 */
function hydrateRowHeadline(
  row: TranscriptRow,
  text: string,
  failed: boolean,
): TranscriptRow {
  const spillFailed = failed ? { spillFailed: true } : {};
  const body = transcriptText(text);
  switch (row.kind) {
    case 'assistant':
    case 'thinking':
    case 'scratchpad':
    case 'log':
      return { ...row, ...spillFailed, text: body };
    case 'user':
      return { ...row, ...spillFailed, text: body, summary: body };
    case 'error':
      return { ...row, ...spillFailed, summary: body };
    default:
      return { ...row, ...spillFailed };
  }
}

export function transcriptReaderTitle(label: string | undefined): string {
  return label ? `Transcript: ${label}` : 'Transcript';
}

export function TranscriptReader({
  availableRows,
  onClose,
  streamId,
  title,
}: {
  readonly availableRows: number;
  readonly onClose: () => void;
  readonly streamId: StreamTabId;
  readonly title: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const streams = useSignal(streamsSignal);
  const slice = streams.get(streamId);
  const frameWidth = formFrameWidth(columns);
  const width = frameWidth - CONFIRM_CARD_HORIZONTAL_DECORATION;
  const [spillState, setSpillState] = useState<{
    readonly streamId: StreamTabId;
    readonly values: ReadonlyMap<string, SpillHydration>;
  }>(() => ({ streamId, values: new Map() }));
  const requestedSpills = useRef<{
    streamId: StreamTabId;
    paths: Set<string>;
  }>({ streamId, paths: new Set() });
  const mounted = useRef(true);

  const spillPaths = useMemo(
    () => [
      ...new Set(
        slice?.entries.flatMap((entry) => entry.spillPath ?? []) ?? [],
      ),
    ],
    [slice],
  );
  const spillPathsKey = spillPaths.join('\0');

  useEffect(() => {
    if (requestedSpills.current.streamId !== streamId) {
      requestedSpills.current = { streamId, paths: new Set() };
      setSpillState({ streamId, values: new Map() });
    }
    const paths = spillPathsKey ? spillPathsKey.split('\0') : [];
    const pending = paths.filter(
      (spillPath) => !requestedSpills.current.paths.has(spillPath),
    );
    if (pending.length === 0) return;
    for (const spillPath of pending) {
      requestedSpills.current.paths.add(spillPath);
    }

    void (async () => {
      const session = tryDefaultSession();
      const flushError = session
        ? await session.flushArtifacts().then(
            () => undefined,
            (error: unknown) => error,
          )
        : new Error('Transcript session is unavailable');
      const resolved = await Promise.all(
        pending.map(
          async (spillPath) =>
            [spillPath, await loadSpill(spillPath, flushError)] as const,
        ),
      );
      if (!mounted.current || requestedSpills.current.streamId !== streamId)
        return;
      setSpillState((current) => {
        const values = new Map(
          current.streamId === streamId ? current.values : [],
        );
        for (const [spillPath, hydration] of resolved) {
          values.set(spillPath, hydration);
        }
        return { streamId, values };
      });
    })();
  }, [spillPathsKey, streamId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const spills =
    spillState.streamId === streamId
      ? spillState.values
      : EMPTY_SPILL_HYDRATIONS;

  const hydratedSlice = useMemo(
    () => hydratedTranscript(slice, spills),
    [slice, spills],
  );

  // Recomputed as the run appends rows, so the reader stays live rather than
  // freezing at the content present when it opened.
  const text = useMemo(() => {
    const body = transcriptToLines(hydratedSlice, width).join('\n').trimEnd();
    return body || EMPTY_TRANSCRIPT_TEXT;
  }, [hydratedSlice, width]);

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
