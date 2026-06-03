import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { writeTextStderr } from '@cli/runtime/logSinks';
import { attachClipboardImage } from '@cli/runtime/clipboardImage';
import { toErrorMessage } from '@common/errors/errorMessage';
import { BaseTextInput } from '../input/BaseTextInput';
import {
  DraftAttachmentStore,
  shouldCollapsePaste,
} from '../input/draftAttachments';
import { ImagePasteQueue } from '../input/imagePasteQueue';
import { ReverseSearch } from '../input/ReverseSearch';
import { isCtrlInput } from '../input/inputKeys';
import { SlashPalette } from '../commands/SlashPalette';
import {
  matchSlashCommands,
  parseSlashInput,
  slashPickIntent,
  type SlashCommand,
  type SlashPickIntent,
} from '../commands/slashRegistry';
import { cliState } from '../state/cliState';
import type { InputHistory } from '../history/inputHistory';

export interface InputBarProps {
  /** Forwarded to BaseTextInput; called only on real (non-paste) Enter.
   *  `mediaFiles` carries absolute paths of any pasted-image attachments. */
  readonly onSubmit: (value: string, mediaFiles?: readonly string[]) => void;
  /** Disable the input while an approval modal is owning the screen. */
  readonly disabled?: boolean;
  /** Preserve component state while giving foreground panels the input rows. */
  readonly collapseWhenDisabled?: boolean;
  /** Prompt prefix (e.g. `>`). */
  readonly prompt?: string;
  /** Persistent input history (optional — undefined disables Ctrl-R). */
  readonly history?: InputHistory;
}

function slashSubmitText(
  current: string,
  commandName: string,
  fallbackRemainder: string,
  typedName?: string,
): string {
  const parsedName = parseSlashInput(current)?.name;
  const nameToReplace =
    typedName && current.startsWith(`/${typedName}`) ? typedName : parsedName;
  if (!nameToReplace) {
    return `/${commandName}${fallbackRemainder ? ` ${fallbackRemainder.trimStart()}` : ''}`;
  }
  const suffix = current.slice(nameToReplace.length + 1);
  const separator = suffix.length > 0 && !/^\s/.test(suffix) ? ' ' : '';
  return `/${commandName}${separator}${suffix}`;
}

export function submitSlashCommandWhenReady({
  commandName,
  fallbackRemainder,
  handleSubmit,
  imagePasteQueue,
  readDraft,
  typedName,
}: {
  readonly commandName: string;
  readonly fallbackRemainder: string;
  readonly handleSubmit: (value: string) => void;
  readonly imagePasteQueue: ImagePasteQueue;
  readonly readDraft: () => string;
  readonly typedName?: string;
}): void {
  imagePasteQueue.runWhenIdle(() => {
    handleSubmit(
      slashSubmitText(readDraft(), commandName, fallbackRemainder, typedName),
    );
  });
}

export function InputBar(props: InputBarProps): React.JSX.Element {
  const { disabled, history, onSubmit, prompt } = props;
  const [value, setValueState] = useState('');
  const [reverseSearchOpen, setReverseSearchOpen] = useState(false);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const draftValueRef = useRef(value);
  const setValue = useCallback((next: string) => {
    draftValueRef.current = next;
    setValueState(next);
  }, []);
  const historyRef = useRef(history);
  historyRef.current = history;
  const imagePasteQueueRef = useRef<ImagePasteQueue | null>(null);
  imagePasteQueueRef.current ??= new ImagePasteQueue();
  const imagePasteQueue = imagePasteQueueRef.current;

  // Collapsed pastes (and, in the image slice, pasted images) live here keyed
  // by chip id and are expanded back into the submitted text at handleSubmit.
  // Ref-held so the store survives re-renders and never triggers one itself.
  const attachmentsRef = useRef(new DraftAttachmentStore());
  const clearDraft = useCallback(() => {
    setValue('');
    attachmentsRef.current.clear();
  }, [setValue]);
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
  const onImagePaste = useCallback(async (): Promise<string | null> => {
    try {
      const result = await attachClipboardImage();
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
      setAttachNotice(`Image paste failed: ${toErrorMessage(error)}`);
      return null;
    }
  }, []);

  // Clear the transient paste notice a few seconds after it appears.
  useEffect(() => {
    if (attachNotice === null) return;
    const timer = setTimeout(() => setAttachNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [attachNotice]);

  // Listen for Ctrl-R *outside* the text input — Ink emits the keystroke
  // to every `useInput` consumer, and BaseTextInput drops unhandled ctrl
  // chords so this handler still fires.
  useInput((input, key) => {
    if (disabled) return;
    if (isCtrlInput(input, key, 'r') && historyRef.current) {
      setReverseSearchOpen(true);
    }
  });

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
        historyText.length > 0 ? historyRef.current?.push(historyText) : null;
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
        const Form = cmd.formComponent;
        clearDraft();
        cliState.activeForm.set({
          commandName: cmd.name,
          render: (close, availableRows) => (
            <Form
              remainder={remainder.trimStart()}
              availableRows={availableRows}
              onDone={() => close()}
            />
          ),
        });
        return;
      }
      if (intent === 'submit') {
        submitSlashCommandWhenReady({
          commandName: cmd.name,
          fallbackRemainder: remainder,
          handleSubmit,
          imagePasteQueue,
          readDraft: () => draftValueRef.current,
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
        const chosen = matchSlashCommands(slash.name)[0];
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
  const hasPaletteMatches =
    parsed !== undefined && matchSlashCommands(parsed.name).length > 0;
  const showPalette =
    parsed !== undefined &&
    isTypingSlashCommandName &&
    hasPaletteMatches &&
    !reverseSearchOpen &&
    !disabled;

  useEffect(() => {
    // Auto-close the reverse-search overlay when the input is disabled —
    // an approval modal taking focus shouldn't trap the user in the
    // search prompt.
    if (disabled && reverseSearchOpen) setReverseSearchOpen(false);
  }, [disabled, reverseSearchOpen]);

  // Surface palette visibility so the App-level Tab handler (focus cycle)
  // can stand down while the palette owns Tab for "accept selection".
  useEffect(() => {
    cliState.slashPaletteOpen.set(showPalette);
    return () => cliState.slashPaletteOpen.set(false);
  }, [showPalette]);

  useEffect(() => {
    cliState.reverseSearchOpen.set(reverseSearchOpen);
    return () => cliState.reverseSearchOpen.set(false);
  }, [reverseSearchOpen]);

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
            setReverseSearchOpen(false);
          }}
          onCancel={() => setReverseSearchOpen(false)}
        />
      ) : null}
      {attachNotice ? <Text dimColor>{attachNotice}</Text> : null}
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="cyan">{prompt ?? '›'} </Text>
        <BaseTextInput
          value={value}
          focus={!disabled && !reverseSearchOpen}
          onChange={setValue}
          imagePasteQueue={imagePasteQueue}
          transformPaste={transformPaste}
          onImagePaste={onImagePaste}
          onImagePasteError={(error) =>
            setAttachNotice(`Image paste failed: ${toErrorMessage(error)}`)
          }
          onInputChunkSubmit={handleInputChunkSubmit}
          onSubmit={showPalette ? () => undefined : handleSubmit}
        />
      </Box>
    </Box>
  );
}
