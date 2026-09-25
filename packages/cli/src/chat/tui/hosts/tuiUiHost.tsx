// The chat TUI's message and dialog surfaces behind the host-neutral
// {@link MessageHost} and {@link PromptHost}: the third implementation of both
// ports, beside `VscodeUiHost` and the desktop's `dialog.showMessageBox`.
//
// A message is a local transcript notice — the CLI's fire-and-forget surface,
// which is why it cannot fail and every member below answers `Effect.sync`.
// A dialog is a foreground form: it takes the App's one `activeForm` slot, so
// a host dialog obeys the same one-modal-at-a-time promotion the approval
// queue does, and a second one waits on this module's lane rather than
// painting over the first. A slash form already in that slot is waited on
// too, through the slot owner in `cliState`. Cancelling is a value, never a failure: `confirm`
// answers `false`, `input` and an answerable message answer `undefined`,
// exactly as the two graphical hosts do.

// Third-party imports
import { Effect, Semaphore } from 'effect';
import { Text } from 'ink';

// Local imports
import type {
  MessageHost,
  NotificationFailed,
  PromptConfirmOptions,
  PromptFailed,
  PromptHost,
  PromptInputOptions,
  PromptMessageItem,
  PromptMessageOptions,
} from '@hosts/uiHosts';

import { TextEntryForm } from '../forms/_shared/TextEntryForm';
import { ListForm } from '../forms/_shared/ListForm';
import { closeActiveForm, openActiveForm } from '../state/formSlot';
import {
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
} from '../state/transcript';

/**
 * One host dialog at a time. Two runs asking at once queue here instead of
 * overwriting each other's form, and the fiber that loses the race is
 * interruptible while it waits — an interrupted waiter never takes the slot.
 */
const dialogLane = Semaphore.makeUnsafe(1);

/** The button label of an item, whichever shape the caller wrote it in. */
function labelOf<T extends string>(item: PromptMessageItem<T>): T {
  return typeof item === 'string' ? item : item.label;
}

/**
 * Put one form in the App's foreground slot and wait for the answer it
 * resolves. The slot is claimed through `openActiveForm`, the one owner both
 * this and the slash-command forms write through, so a dialog opened while a
 * slash form is still on screen waits behind it rather than unmounting it and
 * throwing away what the user typed. The slot is released on every exit: the
 * App closes the form itself when it answers, and the finalizer closes it
 * from here, which gives up a queued place just as it gives up the slot.
 */
function openDialog<T>(
  commandName: string,
  render: (
    answer: (value: T | undefined) => void,
    availableRows: number,
  ) => React.ReactNode,
): Effect.Effect<T | undefined> {
  return dialogLane.withPermit(
    Effect.callback<T | undefined>((resume) => {
      // The form is re-rendered on every frame, so its answer callback is
      // latched: a second keypress landing between the answer and the
      // unmount must not resume this fiber twice.
      let settled = false;
      const form = openActiveForm({
        commandName,
        render: (onDone: () => void, availableRows: number) =>
          render((value) => {
            if (settled) return;
            settled = true;
            onDone();
            resume(Effect.succeed(value));
          }, availableRows),
      });
      return Effect.sync(() => closeActiveForm(form));
    }),
  );
}

/** Pick one of the caller's own labels, or dismiss. */
function chooseItem<T extends string>(
  title: string,
  options: PromptMessageOptions<T>,
  items: readonly PromptMessageItem<T>[],
): Effect.Effect<T | undefined> {
  return openDialog<T>('message', (answer, availableRows) => (
    <ListForm<T>
      title={title}
      availableRows={availableRows}
      items={items.map((item) => ({
        value: labelOf(item),
        label: labelOf(item),
      }))}
      description={
        options.detail ? <Text dimColor>{options.detail}</Text> : undefined
      }
      action="select"
      escapeAction="dismiss"
      onSelect={answer}
      onCancel={() => answer(undefined)}
    />
  ));
}

/**
 * The CLI's own {@link MessageHost} and {@link PromptHost}. Stateless — the
 * transcript and the foreground slot are module-level signals the App reads —
 * so the surfaces that present on it share this one instance, as the VS Code
 * host's surfaces share `vscodeUi`.
 */
class TuiUiHost implements MessageHost, PromptHost {
  showInfoMessage(message: string): Effect.Effect<void, NotificationFailed> {
    return Effect.sync(() => appendLocalAssistantTranscript(message));
  }

  showWarningMessage(message: string): Effect.Effect<void, NotificationFailed> {
    return Effect.sync(() => appendLocalAssistantTranscript(message));
  }

  showErrorMessage(message: string): Effect.Effect<void, NotificationFailed> {
    return Effect.sync(() => appendLocalErrorTranscript(message));
  }

  info<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Effect.Effect<T | undefined, NotificationFailed> {
    return this.present(message, options, appendLocalAssistantTranscript);
  }

  warning<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Effect.Effect<T | undefined, NotificationFailed> {
    return this.present(message, options, appendLocalAssistantTranscript);
  }

  error<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Effect.Effect<T | undefined, NotificationFailed> {
    return this.present(message, options, appendLocalErrorTranscript);
  }

  /**
   * A confirmation is the caller's two labels in the same picker an
   * answerable message uses, so `y`/`n` stay out of the vocabulary here: the
   * approval modals own that pair, and a settings confirmation that borrowed
   * it would read as one of them. Escape is the cancel label's answer, which
   * is what makes a dismissal `false` rather than a failure.
   */
  confirm(
    message: string,
    options: PromptConfirmOptions,
  ): Effect.Effect<boolean, PromptFailed> {
    const confirmLabel = options.confirmLabel;
    const cancelLabel = options.cancelLabel ?? 'Cancel';
    return chooseItem<string>(message, { detail: options.detail }, [
      confirmLabel,
      cancelLabel,
    ]).pipe(Effect.map((selected) => selected === confirmLabel));
  }

  /**
   * Ask for one line of text. `password` masks the entry, which is what every
   * caller of this member in the tree asks for (a provider key, a token), and
   * the unmasked form is the same entry without the mask.
   */
  input(
    options: PromptInputOptions,
  ): Effect.Effect<string | undefined, PromptFailed> {
    return openDialog<string>('input', (answer) => (
      <TextEntryForm
        title={options.prompt ?? 'Enter a value'}
        masked={options.password ?? false}
        placeholder={options.placeHolder ?? ''}
        hint="Press Enter to submit."
        onSubmit={answer}
        onCancel={() => answer(undefined)}
      />
    ));
  }

  /** A message with no items is a notice; one with items is a picker whose
   *  answer is the label the user chose. */
  private present<T extends string>(
    message: string,
    options: PromptMessageOptions<T>,
    notice: (text: string) => void,
  ): Effect.Effect<T | undefined> {
    const items = options.items ?? [];
    if (items.length === 0) {
      return Effect.sync(() => {
        notice(options.detail ? `${message}\n${options.detail}` : message);
        return undefined;
      });
    }
    return chooseItem(message, options, items);
  }
}

/** The process's one instance, shared by every TUI surface that presents. */
export const tuiUi = new TuiUiHost();
