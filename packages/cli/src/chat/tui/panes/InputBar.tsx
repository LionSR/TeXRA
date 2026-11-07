import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { Box, Text, useInput, useWindowSize, type Key } from 'ink';
import { Cause, Effect, SubscriptionRef } from 'effect';

import { toErrorMessage } from '@texra-ai/harness/schemas';
import { attachClipboardImage } from '@cli/runtime/terminal/clipboardImage';
import { writeTextStderr } from '@cli/runtime/platform/logSinks';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { isCtrlInput } from '@cli/tui/inputKeys';
import { COLOR_BORDER, COLOR_HINT } from '@cli/tui/ui/colors';
import { POINTER } from '@cli/tui/ui/glyphs';
import { BaseTextInput } from '../input/BaseTextInput';
import { textInputCappedRowCount } from '../input/textInputDisplay';
import {
  EMPTY_DRAFT,
  expandText,
  expandTextForHistory,
  shouldCollapsePaste,
  withPastedImage,
  withPastedText,
  withText,
  type Draft,
} from '../input/draftAttachments';
import { useImagePastes } from '../input/imagePasteQueue';
import { ReverseSearch } from '../input/ReverseSearch';
import {
  appendSlashCommandEcho,
  openRegisteredCliSlashForm,
} from '../commands/slashForms';
import { SlashPalette, slashPaletteOwnsArrows } from '../commands/SlashPalette';
import {
  parseSlashInput,
  useSlashCommands,
  type SlashCommand,
  type SlashPickIntent,
} from '../commands/slashRegistry';
import {
  inputBarContentRows,
  reverseSearchOpen as reverseSearchOpenSignal,
  setTransientNotice,
  slashPaletteOpen,
} from '../state/cliState';
import { useSignal } from '../state/useSignal';
import { useSubscriptionRef } from '../state/useSubscriptionRef';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ProcessRuntime } from '@texra-ai/harness/host';
import type { CursorEdit } from '../input/textInputEditing';
import type { InputHistory } from '../history/inputHistory';

const CSI_SEQUENCE_TAIL_RE = /^\[[0-?]*[ -/]*[@-~]$/u;

interface InputBarProps {
  /** The process runtime the history write and the Ctrl-V image probe run
   *  on, threaded from the chat root that holds it — this bar runs no
   *  Effect of its own. */
  readonly runtime: ProcessRuntime;
  /** The chat session's roots: the Ctrl-V image probe writes under this
   *  project's own storage, never under whichever root a later call reads. */
  readonly roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>;
  /** The chat's draft: what the input shows, its chips' content and the
   *  activated skills. A message the session does not take comes back here. */
  readonly draft: SubscriptionRef.SubscriptionRef<Draft>;
  /** Called with the submitted draft only on real (non-paste) Enter, or on
   *  Shift-Tab with `holdUntil: 'turn'`. */
  readonly onSubmit: (draft: Draft, holdUntil?: 'turn') => void;
  /** Disable the input while an approval modal is owning the screen. */
  readonly disabled?: boolean;
  /** Inline reason shown when the disabled input remains visible. */
  readonly disabledMessage?: string;
  /** Preserve component state while giving foreground panels the input rows. */
  readonly collapseWhenDisabled?: boolean;
  /** Persistent input history (optional — undefined disables Ctrl-R). */
  readonly history?: InputHistory;
  /** Whether the input currently owns terminal keys. */
  readonly keyboardActive?: boolean;
  /** Root-owned handle for draft-aware keyboard policy. */
  readonly controlRef?: React.Ref<InputBarHandle>;
  /** Whether the root holds this typed key for itself (an `Esc 1..9` chord
   *  is pending): the draft drops it, and the root either spends it or hands
   *  it back through `appendInput`. */
  readonly holdsKeystroke?: (input: string, key: Key) => boolean;
}

export interface InputBarHandle {
  readonly appendInput: (input: string) => void;
}

function slashSubmitText(
  current: string,
  commandName: string,
  remainder: string,
  typedName?: string,
): string {
  const parsedName = parseSlashInput(current)?.name;
  const nameToReplace =
    typedName && current.startsWith(`/${typedName}`) ? typedName : parsedName;
  if (!nameToReplace) {
    return `/${commandName}${remainder ? ` ${remainder.trimStart()}` : ''}`;
  }
  const suffix = current.slice(nameToReplace.length + 1);
  const separator = /^\S/.test(suffix) ? ' ' : '';
  return `/${commandName}${separator}${suffix}`;
}

/** Cap on visible draft rows: a huge paste windows instead of consuming the
 *  transcript. Must match `maxDisplayRows` so Box height and the caret-aware
 *  window share one budget (see textInputCappedRowCount). */
const INPUT_BAR_MAX_CONTENT_ROWS = 5;
/** Round border (2) + paddingX (2) + pointer prompt `› ` (2). Must match
 *  the rendered chrome exactly: telling the window a wider width than Ink
 *  actually gives the inner Text makes Ink re-wrap the windowed row and the
 *  overflow row gets clipped by the height-capped Box. */
const INPUT_BAR_DECORATION_COLUMNS = 6;

export function InputBar(props: InputBarProps): React.JSX.Element {
  const { disabled, history, holdsKeystroke, onSubmit, roots, runtime } = props;
  const draftRef = props.draft;
  const keyboardActive = props.keyboardActive ?? true;
  const value = useSubscriptionRef(runtime, draftRef).text;
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
  const { columns } = useWindowSize();
  const commands = useSlashCommands();
  // Reads and writes go to the ref at once, so a keystroke chunk handled
  // before the next render sees the one before it.
  const readDraft = useCallback(
    () => SubscriptionRef.getUnsafe(draftRef),
    [draftRef],
  );
  const writeDraft = useCallback(
    (next: Draft) => runtime.runSync(SubscriptionRef.set(draftRef, next)),
    [draftRef, runtime],
  );
  // ↑/↓ history browsing (shell-style). `index` walks the persisted entries,
  // `savedDraft` restores whatever was typed before browsing began, and
  // `applied` detects edits to a recalled entry, which end the browse.
  const historyBrowseRef = useRef<
    { index: number; savedDraft: string; applied: string } | undefined
  >(undefined);
  const setValue = useCallback(
    (next: string) => {
      if (next !== historyBrowseRef.current?.applied) {
        historyBrowseRef.current = undefined;
      }
      writeDraft(withText(readDraft(), next));
    },
    [readDraft, writeDraft],
  );
  const historyRef = useRef(history);
  historyRef.current = history;
  const browseHistory = useCallback(
    (direction: -1 | 1) => {
      const entries = historyRef.current;
      const browse = historyBrowseRef.current;
      if (!entries || (!browse && direction === 1)) return;
      const index = (browse?.index ?? entries.length()) + direction;
      if (index < 0) return;
      const savedDraft = browse?.savedDraft ?? readDraft().text;
      // Walking ↓ past the newest entry restores the pre-browse draft.
      const entry = entries.at(index);
      historyBrowseRef.current =
        entry === undefined ? undefined : { index, savedDraft, applied: entry };
      writeDraft(withText(readDraft(), entry ?? savedDraft));
    },
    [readDraft, writeDraft],
  );
  const imagePasteQueue = useImagePastes(runtime);

  const clearDraft = useCallback(() => {
    imagePasteQueue.discardPending();
    setValue('');
  }, [imagePasteQueue, setValue]);
  const clearDraftEdit = useCallback<CursorEdit>(() => {
    clearDraft();
    return { value: '', cursor: 0 };
  }, [clearDraft]);
  const appendInput = useCallback(
    (input: string): void => setValue(`${readDraft().text}${input}`),
    [readDraft, setValue],
  );
  useImperativeHandle(props.controlRef, () => ({ appendInput }), [appendInput]);
  const replaceSlashTriggerInput = useCallback(
    (input: string, value: string, cursor: number) => {
      if (value === '/' && cursor === 1 && input.startsWith('/')) {
        return { value: '', cursor: 0 };
      }
      return undefined;
    },
    [],
  );
  const dropSlashPaletteControlTail = useCallback(
    (input: string, value: string, cursor: number) =>
      value === '/' && cursor === 1 && CSI_SEQUENCE_TAIL_RE.test(input),
    [],
  );
  const dropHeldKeystroke = useCallback(
    (input: string, _value: string, _cursor: number, key: Key) =>
      holdsKeystroke?.(input, key) === true,
    [holdsKeystroke],
  );
  const replaceDraft = useCallback(
    (next: string) =>
      writeDraft({ ...EMPTY_DRAFT, text: next, skills: readDraft().skills }),
    [readDraft, writeDraft],
  );
  const transformPaste = useCallback(
    (text: string): string => {
      if (!shouldCollapsePaste(text)) return text;
      const pasted = withPastedText(readDraft(), text);
      writeDraft(pasted.draft);
      return pasted.chip;
    },
    [readDraft, writeDraft],
  );
  const onImagePaste = useMemo(
    () => ({
      pastes: imagePasteQueue,
      probe: () =>
        Effect.map(attachClipboardImage(roots), (result): string | null => {
          if (!result.ok) {
            setTransientNotice(result.reason);
            return null;
          }
          const pasted = withPastedImage(readDraft(), {
            path: result.path,
            mediaType: result.mediaType,
            displayName: result.displayName,
          });
          writeDraft(pasted.draft);
          return pasted.chip;
        }),
      onError: (error: unknown) =>
        setTransientNotice(`Image paste failed: ${toErrorMessage(error)}`, {
          ttlMs: Number.POSITIVE_INFINITY,
        }),
    }),
    [imagePasteQueue, readDraft, roots, writeDraft],
  );

  // Listen for Ctrl-R *outside* the text input — Ink emits the keystroke
  // to every `useInput` consumer, and BaseTextInput drops unhandled ctrl
  // chords so this handler still fires. `isActive` (rather than an internal
  // early-return) releases the stdin subscription entirely while a foreground
  // surface owns input, matching BaseTextInput's `isActive: focus`.
  useInput(
    (input, key) => {
      if (isCtrlInput(input, key, 'r') && historyRef.current) {
        reverseSearchOpenSignal.set(true);
      }
    },
    { isActive: !disabled && keyboardActive },
  );

  const handleSubmit = useCallback(
    (submitted: string, holdUntil?: 'turn') => {
      const message = withText(readDraft(), submitted);
      if (expandText(message).trim().length === 0) {
        clearDraft();
        return;
      }
      const historyText = expandTextForHistory(message).trim();
      clearDraft();
      // Persisting history is best-effort — a disk failure (read-only fs,
      // ENOSPC) must not block the submit. Surface the failure through the
      // shared log sink so it isn't completely silent.
      const historyPersist =
        historyText.length > 0 && !commands.shouldRedact(historyText)
          ? historyRef.current?.push(historyText)
          : undefined;
      if (historyPersist) {
        runtime.runFork(
          Effect.catchCause(historyPersist, (cause) =>
            Effect.sync(() => {
              writeTextStderr(
                `texra: failed to persist input history: ${String(Cause.squash(cause))}`,
              );
            }),
          ),
        );
      }
      onSubmit(message, holdUntil);
    },
    [clearDraft, commands, onSubmit, readDraft, runtime],
  );

  const acceptSlashCommand = useCallback(
    (
      cmd: SlashCommand,
      intent: SlashPickIntent,
      typedName: string,
      remainder: string,
    ): void => {
      if (cmd.formComponent) {
        const commandLine = slashSubmitText(
          readDraft().text,
          cmd.name,
          remainder,
          typedName,
        );
        // Structured forms own the screen — clear the input and let
        // the active-form signal mount the component (see App.tsx).
        clearDraft();
        openRegisteredCliSlashForm(cmd, () =>
          appendSlashCommandEcho(commands, commandLine),
        );
        return;
      }
      if (intent === 'submit') {
        imagePasteQueue.runWhenIdle(() => {
          handleSubmit(
            slashSubmitText(readDraft().text, cmd.name, remainder, typedName),
          );
        });
        return;
      }
      replaceDraft(
        `/${cmd.name}${remainder ? ` ${remainder.trimStart()}` : ' '}`,
      );
    },
    [
      clearDraft,
      commands,
      handleSubmit,
      imagePasteQueue,
      readDraft,
      replaceDraft,
    ],
  );

  const handleInputChunkSubmit = useCallback(
    (submitted: string) => {
      const slash = parseSlashInput(submitted);
      if (slash !== undefined && !/\s/.test(submitted.slice(1))) {
        // Batched chunks (e.g. a paste ending in a newline) never showed the
        // palette, so only auto-run prefix matches here — the substring/typo
        // fallbacks are palette-only, where the user previews the match.
        // Unmatched input falls through to the unknown-command suggestion.
        const chosen = commands.prefix(slash.name)[0];
        if (chosen !== undefined) {
          acceptSlashCommand(chosen, 'submit', slash.name, slash.remainder);
          return;
        }
      }
      handleSubmit(submitted);
    },
    [acceptSlashCommand, commands, handleSubmit],
  );

  // Slash palette pops up while typing /…
  const parsed = parseSlashInput(value);
  const paletteMatchCount =
    parsed !== undefined ? commands.match(parsed.name).length : 0;
  const showPalette =
    parsed !== undefined &&
    !/\s/.test(value.slice(1)) &&
    paletteMatchCount > 0 &&
    !reverseSearchOpen &&
    !disabled &&
    keyboardActive;
  // The palette owns ↑/↓ only while it presents a real choice (2+ matches);
  // with a single match — e.g. a fully typed command name — the arrows keep
  // recalling input history.
  const paletteOwnsArrows =
    showPalette && slashPaletteOwnsArrows(paletteMatchCount);

  useEffect(() => {
    // Auto-close the reverse-search overlay when the input is disabled —
    // an approval modal taking focus shouldn't trap the user in the
    // search prompt.
    if ((!keyboardActive || disabled) && reverseSearchOpen) {
      reverseSearchOpenSignal.set(false);
    }
  }, [disabled, keyboardActive, reverseSearchOpen]);

  // Surface palette visibility so the App-level Tab handler (session-list
  // focus) can stand down while the palette owns Tab for "accept selection".
  useEffect(() => {
    slashPaletteOpen.set(showPalette);
    return () => slashPaletteOpen.set(false);
  }, [showPalette]);

  // reverseSearchOpen lives in foregroundOverlaySlice directly (read via
  // useSignal above), so only the unmount reset needs an effect here.
  useEffect(() => () => reverseSearchOpenSignal.set(false), []);

  // Report the windowed draft height so the row allocator shrinks the
  // transcript for a multi-line draft instead of the input box growing the
  // live frame past the terminal (per-keystroke scrollback churn). One frame
  // of lag (signal set post-render) beats a whole draft-lifetime of overflow.
  const inputDisplayWidth = Math.max(1, columns - INPUT_BAR_DECORATION_COLUMNS);
  const disabledDisplayText = props.disabledMessage
    ? wrapAnsiToWidth(props.disabledMessage, inputDisplayWidth)
    : undefined;
  const disabledContentRows = disabledDisplayText
    ? Math.min(
        INPUT_BAR_MAX_CONTENT_ROWS,
        disabledDisplayText.split('\n').length,
      )
    : 1;
  const draftContentRows = disabled
    ? disabledContentRows
    : textInputCappedRowCount(
        value,
        inputDisplayWidth,
        INPUT_BAR_MAX_CONTENT_ROWS,
      );
  useEffect(() => {
    inputBarContentRows.set(draftContentRows);
  }, [draftContentRows]);
  useEffect(() => () => inputBarContentRows.set(1), []);

  if (disabled && props.collapseWhenDisabled) return <></>;

  return (
    <Box flexDirection="column">
      {showPalette ? (
        <SlashPalette
          query={parsed.name}
          onPick={(cmd, intent) => {
            acceptSlashCommand(cmd, intent, parsed.name, parsed.remainder);
          }}
        />
      ) : null}
      {reverseSearchOpen && historyRef.current ? (
        <ReverseSearch
          history={historyRef.current}
          onCommit={(line) => {
            replaceDraft(line);
            reverseSearchOpenSignal.set(false);
          }}
          onCancel={() => reverseSearchOpenSignal.set(false)}
        />
      ) : null}
      <Box
        borderStyle="round"
        borderColor={COLOR_BORDER}
        paddingX={1}
        aria-role="textbox"
        aria-state={{ disabled }}
      >
        <Text aria-hidden color={COLOR_HINT}>
          {POINTER}{' '}
        </Text>
        <Box
          flexGrow={1}
          flexShrink={1}
          height={draftContentRows}
          overflowY="hidden"
        >
          {disabled && props.disabledMessage ? (
            <Text dimColor>{disabledDisplayText}</Text>
          ) : (
            <BaseTextInput
              value={value}
              focus={keyboardActive && !disabled && !reverseSearchOpen}
              onChange={setValue}
              displayWidth={inputDisplayWidth}
              maxDisplayRows={draftContentRows}
              // While the palette shows multiple rows it owns ↑/↓ for row
              // selection; history recall would clobber the draft mid-navigation.
              onHistoryUp={
                paletteOwnsArrows ? undefined : () => browseHistory(-1)
              }
              onHistoryDown={
                paletteOwnsArrows ? undefined : () => browseHistory(1)
              }
              readLatestValue={() => readDraft().text}
              prepareInputChunk={
                showPalette ? replaceSlashTriggerInput : undefined
              }
              shouldDropInputChunk={
                showPalette ? dropSlashPaletteControlTail : dropHeldKeystroke
              }
              // Esc clears the slash, closing the palette; typing reopens it.
              escapeEdit={showPalette ? clearDraftEdit : undefined}
              transformPaste={transformPaste}
              onImagePaste={onImagePaste}
              onInputChunkSubmit={handleInputChunkSubmit}
              onSubmit={showPalette ? () => undefined : handleSubmit}
              onSubmitHeld={
                showPalette
                  ? undefined
                  : (submitted) => handleSubmit(submitted, 'turn')
              }
            />
          )}
        </Box>
      </Box>
    </Box>
  );
}
