import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Box, Text, useInput } from 'ink';

import { writeTextStderr } from '@cli/runtime/logSinks';
import { attachClipboardImage } from '@cli/runtime/clipboardImage';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { BaseTextInput } from '../input/BaseTextInput';
import {
  DraftAttachmentStore,
  shouldCollapsePaste,
} from '../input/draftAttachments';
import {
  ImagePasteQueue,
  type ImagePasteAttempt,
} from '../input/imagePasteQueue';
import { ReverseSearch } from '../input/ReverseSearch';
import { isCtrlInput } from '../input/inputKeys';
import { openRegisteredCliSlashForm } from '../commands/slashForms';
import { SlashPalette, slashPaletteOwnsArrows } from '../commands/SlashPalette';
import { COLOR_BORDER, COLOR_HINT } from '../ui/colors';
import { POINTER } from '../ui/glyphs';
import {
  findSlashCommand,
  matchSlashCommands,
  parseSlashInput,
  prefixSlashCommands,
  slashPickIntent,
  type SlashCommand,
  type SlashPickIntent,
} from '../commands/slashRegistry';
import {
  reverseSearchOpen as reverseSearchOpenSignal,
  slashPaletteOpen,
} from '../state/cliState';
import { useSignal } from '../state/useSignal';
import type { CursorEdit } from '../input/textInputEditing';
import type { InputHistory } from '../history/inputHistory';

const CSI_SEQUENCE_TAIL_RE = /^\[[0-?]*[ -/]*[@-~]$/u;

export interface InputBarProps {
  /** Forwarded to BaseTextInput; called only on real (non-paste) Enter.
   *  `mediaFiles` carries absolute paths of any pasted-image attachments. */
  readonly onSubmit: (value: string, mediaFiles?: readonly string[]) => void;
  /** Disable the input while an approval modal is owning the screen. */
  readonly disabled?: boolean;
  /** Inline reason shown when the disabled input remains visible. */
  readonly disabledMessage?: string;
  /** Preserve component state while giving foreground panels the input rows. */
  readonly collapseWhenDisabled?: boolean;
  /** Prompt prefix (e.g. `>`). */
  readonly prompt?: string;
  /** Persistent input history (optional — undefined disables Ctrl-R). */
  readonly history?: InputHistory;
  /** Whether the input currently owns terminal keys. */
  readonly keyboardActive?: boolean;
  /** Root-owned handle for draft-aware keyboard policy. */
  readonly controlRef?: React.Ref<InputBarHandle>;
}

export interface InputBarHandle {
  readonly discardDraft: () => boolean;
}

/** Whether a submitted line is safe to retain in persistent input history. */
export function shouldPersistInputHistory(input: string): boolean {
  const parsed = parseSlashInput(input);
  return (
    parsed === undefined || findSlashCommand(parsed.name)?.redactInput !== true
  );
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
  const separator = suffix.length > 0 && !/^\s/.test(suffix) ? ' ' : '';
  return `/${commandName}${separator}${suffix}`;
}

export function submitSlashCommandWhenReady({
  commandName,
  handleSubmit,
  imagePasteQueue,
  readDraft,
  remainder,
  typedName,
}: {
  readonly commandName: string;
  readonly handleSubmit: (value: string) => void;
  readonly imagePasteQueue: ImagePasteQueue;
  readonly readDraft: () => string;
  readonly remainder: string;
  readonly typedName?: string;
}): void {
  imagePasteQueue.runWhenIdle(() => {
    handleSubmit(
      slashSubmitText(readDraft(), commandName, remainder, typedName),
    );
  });
}

export function InputBar(props: InputBarProps): React.JSX.Element {
  const { disabled, history, onSubmit, prompt } = props;
  const keyboardActive = props.keyboardActive ?? true;
  const [value, setValueState] = useState('');
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const draftValueRef = useRef(value);
  // ↑/↓ history browsing (shell-style). `index` walks the persisted entries,
  // `savedDraft` restores whatever was typed before browsing began, and
  // `applied` detects edits to a recalled entry, which end the browse.
  const historyBrowseRef = useRef<
    { index: number; savedDraft: string; applied: string } | undefined
  >(undefined);
  const setValue = useCallback((next: string) => {
    draftValueRef.current = next;
    if (next !== historyBrowseRef.current?.applied) {
      historyBrowseRef.current = undefined;
    }
    setValueState(next);
  }, []);
  const historyRef = useRef(history);
  historyRef.current = history;
  const browseHistory = useCallback((direction: -1 | 1) => {
    const entries = historyRef.current;
    const browse = historyBrowseRef.current;
    if (!entries || (!browse && direction === 1)) return;
    const index = (browse?.index ?? entries.length()) + direction;
    if (index < 0) return;
    const savedDraft = browse?.savedDraft ?? draftValueRef.current;
    // Walking ↓ past the newest entry restores the pre-browse draft.
    const entry = entries.at(index);
    historyBrowseRef.current =
      entry === undefined ? undefined : { index, savedDraft, applied: entry };
    draftValueRef.current = entry ?? savedDraft;
    setValueState(entry ?? savedDraft);
  }, []);
  const imagePasteQueueRef = useRef<ImagePasteQueue | null>(null);
  imagePasteQueueRef.current ??= new ImagePasteQueue();
  const imagePasteQueue = imagePasteQueueRef.current;

  // Collapsed pastes (and, in the image slice, pasted images) live here keyed
  // by chip id and are expanded back into the submitted text at handleSubmit.
  // Ref-held so the store survives re-renders and never triggers one itself.
  const attachmentsRef = useRef(new DraftAttachmentStore());
  const clearDraft = useCallback(() => {
    imagePasteQueue.discardPending();
    setValue('');
    attachmentsRef.current.clear();
  }, [imagePasteQueue, setValue]);
  const clearDraftEdit = useCallback<CursorEdit>(() => {
    clearDraft();
    return { value: '', cursor: 0 };
  }, [clearDraft]);
  const discardDraft = useCallback((): boolean => {
    if (
      draftValueRef.current.length === 0 &&
      !imagePasteQueue.hasPending &&
      !imagePasteQueue.hasDeferredAction
    ) {
      return false;
    }
    clearDraft();
    return true;
  }, [clearDraft, imagePasteQueue]);
  useImperativeHandle(props.controlRef, () => ({ discardDraft }), [
    discardDraft,
  ]);
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
  const replaceDraft = useCallback(
    (next: string) => {
      setValue(next);
      attachmentsRef.current.clear();
    },
    [setValue],
  );
  const transformPaste = useCallback((text: string): string => {
    if (!shouldCollapsePaste(text)) return text;
    return attachmentsRef.current.addPastedText(text);
  }, []);
  const onImagePaste = useCallback(
    async (attempt: ImagePasteAttempt): Promise<string | null> => {
      try {
        const result = await attachClipboardImage();
        if (!attempt.isCurrent()) return null;
        if (!result.ok) {
          setAttachNotice(result.reason);
          return null;
        }
        return attachmentsRef.current.addPastedImage({
          path: result.path,
          mediaType: result.mediaType,
          displayName: result.displayName,
        });
      } catch (error) {
        if (attempt.isCurrent()) {
          setAttachNotice(`Image paste failed: ${toErrorMessage(error)}`);
        }
        return null;
      }
    },
    [],
  );

  // Clear the transient paste notice a few seconds after it appears.
  useEffect(() => {
    if (attachNotice === null) return;
    const timer = setTimeout(() => setAttachNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [attachNotice]);

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
    (submitted: string) => {
      const store = attachmentsRef.current;
      // Expand `[Pasted text #N …]` chips back to their full content, and
      // collect any pasted-image attachments still referenced in the draft.
      const trimmed = store.expandText(submitted).trim();
      if (trimmed.length === 0) {
        clearDraft();
        return;
      }
      const mediaFiles = store.resolveMedia(submitted);
      const historyText = store.expandTextForHistory(submitted).trim();
      clearDraft();
      // Persisting history is best-effort — a disk failure (read-only fs,
      // ENOSPC) must not block the submit. Surface the failure through the
      // shared log sink so it isn't completely silent.
      const historyPersist =
        historyText.length > 0 && shouldPersistInputHistory(historyText)
          ? historyRef.current?.push(historyText)
          : null;
      historyPersist?.catch((err: unknown) => {
        writeTextStderr(
          `texra: failed to persist input history: ${String(err)}`,
        );
      });
      onSubmit(trimmed, mediaFiles.length > 0 ? mediaFiles : undefined);
    },
    [clearDraft, onSubmit],
  );

  const acceptSlashCommand = useCallback(
    (
      cmd: SlashCommand,
      intent: SlashPickIntent,
      typedName: string,
      remainder: string,
    ): void => {
      if (cmd.formComponent) {
        // Structured forms own the screen — clear the input and let
        // the active-form signal mount the component (see App.tsx).
        clearDraft();
        openRegisteredCliSlashForm(cmd, remainder);
        return;
      }
      if (intent === 'submit') {
        submitSlashCommandWhenReady({
          commandName: cmd.name,
          handleSubmit,
          imagePasteQueue,
          readDraft: () => draftValueRef.current,
          remainder,
          typedName,
        });
        return;
      }
      replaceDraft(
        `/${cmd.name}${remainder ? ` ${remainder.trimStart()}` : ' '}`,
      );
    },
    [clearDraft, handleSubmit, imagePasteQueue, replaceDraft],
  );

  const handleInputChunkSubmit = useCallback(
    (submitted: string) => {
      const slash = parseSlashInput(submitted);
      if (slash !== undefined && !/\s/.test(submitted.slice(1))) {
        // Batched chunks (e.g. a paste ending in a newline) never showed the
        // palette, so only auto-run prefix matches here — the substring/typo
        // fallbacks are palette-only, where the user previews the match.
        // Unmatched input falls through to the unknown-command suggestion.
        const chosen = prefixSlashCommands(slash.name)[0];
        if (chosen !== undefined) {
          acceptSlashCommand(
            chosen,
            slashPickIntent(chosen, 'enter'),
            slash.name,
            slash.remainder,
          );
          return;
        }
      }
      handleSubmit(submitted);
    },
    [acceptSlashCommand, handleSubmit],
  );

  // Slash palette pops up while typing /…
  const parsed = parseSlashInput(value);
  const isTypingSlashCommandName =
    parsed !== undefined && !/\s/.test(value.slice(1));
  const paletteMatchCount =
    parsed !== undefined ? matchSlashCommands(parsed.name).length : 0;
  const showPalette =
    parsed !== undefined &&
    isTypingSlashCommandName &&
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

  if (disabled && props.collapseWhenDisabled) return <></>;

  return (
    <Box flexDirection="column">
      {showPalette ? (
        <SlashPalette
          query={parsed.name}
          onPick={(cmd, intent) => {
            acceptSlashCommand(cmd, intent, parsed.name, parsed.remainder);
          }}
          onCancel={() => {
            /* Esc clears the slash — caller can re-open by typing again. */
            clearDraft();
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
      {attachNotice ? <Text dimColor>{attachNotice}</Text> : null}
      <Box
        borderStyle="round"
        borderColor={COLOR_BORDER}
        paddingX={1}
        aria-role="textbox"
      >
        <Text aria-hidden color={COLOR_HINT}>
          {prompt ?? POINTER}{' '}
        </Text>
        {disabled && props.disabledMessage ? (
          <Text dimColor>{props.disabledMessage}</Text>
        ) : (
          <BaseTextInput
            value={value}
            focus={keyboardActive && !disabled && !reverseSearchOpen}
            onChange={setValue}
            // While the palette shows multiple rows it owns ↑/↓ for row
            // selection; history recall would clobber the draft mid-navigation.
            onHistoryUp={
              paletteOwnsArrows ? undefined : () => browseHistory(-1)
            }
            onHistoryDown={
              paletteOwnsArrows ? undefined : () => browseHistory(1)
            }
            imagePasteQueue={imagePasteQueue}
            readLatestValue={() => draftValueRef.current}
            prepareInputChunk={
              showPalette ? replaceSlashTriggerInput : undefined
            }
            shouldDropInputChunk={
              showPalette ? dropSlashPaletteControlTail : undefined
            }
            escapeEdit={showPalette ? clearDraftEdit : undefined}
            transformPaste={transformPaste}
            onImagePaste={onImagePaste}
            onImagePasteError={(error) =>
              setAttachNotice(`Image paste failed: ${toErrorMessage(error)}`)
            }
            onInputChunkSubmit={handleInputChunkSubmit}
            onSubmit={showPalette ? () => undefined : handleSubmit}
          />
        )}
      </Box>
    </Box>
  );
}
