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
import { isEscapeInput } from '@cli/tui/inputKeys';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import { KeyHints, READER_SCROLL_HINTS } from '@cli/tui/ui/KeyHints';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { CONFIRM_CARD_HORIZONTAL_DECORATION } from '@cli/tui/ui/theme';
import type { StreamTabId } from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { readTranscriptSpill } from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { formFrameWidth } from '../forms/_shared/FormFrame';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from '../modals/ScrollableModalText';
import { normalizeKnownHtmlForCliMarkdown } from '../render/htmlMarkdownNormalize';
import {
  streams as streamsSignal,
  type ConversationEntry,
  type StreamSlice,
} from '../state/cliState';
import { transcriptToLines } from '../state/transcriptLines';
import { useSignal } from '../state/useSignal';
import { trimAssistantTranscriptLead } from './transcriptEntries';

const EMPTY_TRANSCRIPT_TEXT = '(no output yet)';
const MISSING_SPILL_TEXT =
  '[Full output is unavailable because this run artifact was deleted.]';

type SpillHydration =
  | { readonly kind: 'loaded'; readonly text: string }
  | { readonly kind: 'failed'; readonly notice: string };

const EMPTY_SPILL_HYDRATIONS: ReadonlyMap<string, SpillHydration> = new Map();

async function loadSpill(
  spillPath: string,
  flushError: unknown,
): Promise<SpillHydration> {
  try {
    const text = await readTranscriptSpill(spillPath);
    if (text !== undefined) return { kind: 'loaded', text };
    return flushError === undefined
      ? { kind: 'failed', notice: MISSING_SPILL_TEXT }
      : {
          kind: 'failed',
          notice: `[Unable to prepare full output. Close and reopen the transcript to retry: ${toErrorMessage(flushError)}]`,
        };
  } catch (error) {
    return {
      kind: 'failed',
      notice: `[Unable to read full output. Close and reopen the transcript to retry: ${toErrorMessage(error)}]`,
    };
  }
}

function withSpillNotice(preview: string, notice: string): string {
  return preview ? `${preview}\n\n${notice}` : notice;
}

function hydratedTranscript(
  slice: StreamSlice | undefined,
  spills: ReadonlyMap<string, SpillHydration>,
): StreamSlice | undefined {
  if (!slice || spills.size === 0) return slice;
  const entries = slice.entries.map((entry): ConversationEntry => {
    const spill = entry.spillPath ? spills.get(entry.spillPath) : undefined;
    if (spill === undefined) return entry;
    if (entry.role === 'tool') {
      return {
        ...entry,
        toolUse: {
          ...entry.toolUse,
          outputText:
            spill.kind === 'loaded'
              ? spill.text
              : withSpillNotice(entry.toolUse.outputText, spill.notice),
        },
      };
    }
    return {
      ...entry,
      text:
        spill.kind === 'loaded'
          ? normalizeKnownHtmlForCliMarkdown(
              trimAssistantTranscriptLead(spill.text),
            )
          : withSpillNotice(entry.text, spill.notice),
    };
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
