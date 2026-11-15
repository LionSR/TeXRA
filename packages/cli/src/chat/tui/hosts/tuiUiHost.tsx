// The chat TUI's dialog surface, the host-neutral {@link Dialogs}.
//
// A notice is a local transcript notice — the CLI's fire-and-forget surface,
// which is why it cannot fail and answers `Effect.sync`.
// A dialog is a foreground form: it takes the App's one `activeForm` slot, so
// a host dialog obeys the same one-modal-at-a-time promotion the approval
// queue does, and a second one, like a dialog arriving while a slash form
// holds the slot, waits in the slot's own queue (`formSlot`) rather than
// painting over the first. Cancelling is a value, never a failure: `confirm`
// answers `false` and `input` answers `undefined`, exactly as the two
// graphical hosts do.

// Third-party imports
import { Effect } from 'effect';
import { Text } from 'ink';

// Local imports
import type {
  ConfirmQuestion,
  Dialogs,
  HostFailed,
  InputField,
  NoticeLevel,
} from '@texra/hosts/uiHosts';

import { TextEntryForm } from '../forms/_shared/TextEntryForm';
import { ListForm } from '../forms/_shared/ListForm';
import { closeActiveForm, openActiveForm } from '../state/formSlot';
import { appendLocalNotice } from '../state/transcript';

/**
 * Put one form in the App's foreground slot and wait for the answer it
 * resolves. The slot is claimed through `openActiveForm`, the one owner both
 * this and the slash-command forms write through, so a dialog opened while a
 * slash form or another dialog is still on screen waits behind it, in arrival
 * order, rather than unmounting it and throwing away what the user typed. The
 * slot is released on every exit: the App closes the form itself when it
 * answers, and the finalizer closes it from here, which gives up a queued
 * place just as it gives up the slot.
 */
function openDialog<T>(
  commandName: string,
  render: (
    answer: (value: T | undefined) => void,
    availableRows: number,
  ) => React.ReactNode,
): Effect.Effect<T | undefined> {
  return Effect.callback<T | undefined>((resume) => {
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
  });
}

/** Pick one of the caller's own labels, or dismiss. */
function chooseItem(
  title: string,
  detail: string | undefined,
  labels: readonly string[],
): Effect.Effect<string | undefined> {
  return openDialog<string>('message', (answer, availableRows) => (
    <ListForm<string>
      title={title}
      availableRows={availableRows}
      items={labels.map((label) => ({ value: label, label }))}
      description={detail ? <Text dimColor>{detail}</Text> : undefined}
      action="select"
      escapeAction="dismiss"
      onSelect={answer}
      onCancel={() => answer(undefined)}
    />
  ));
}

/**
 * The CLI's {@link Dialogs}. Stateless — the transcript and the foreground
 * slot are module-level signals the App reads — so the surfaces that present
 * on it share this one instance, as the VS Code host's surfaces share
 * `vscodeUi`.
 */
class TuiUiHost implements Dialogs {
  /** A transcript notice; its level reads from the words. */
  notify(_level: NoticeLevel, message: string): Effect.Effect<void> {
    return Effect.sync(() => appendLocalNotice(message));
  }

  /**
   * A confirmation is the action and Cancel in a picker, so `y`/`n` stay
   * out of the vocabulary here: the
   * approval modals own that pair, and a settings confirmation that borrowed
   * it would read as one of them. Escape is the cancel label's answer, which
   * is what makes a dismissal `false` rather than a failure.
   */
  confirm(question: ConfirmQuestion): Effect.Effect<boolean, HostFailed> {
    return chooseItem(question.message, question.detail, [
      question.action,
      'Cancel',
    ]).pipe(Effect.map((selected) => selected === question.action));
  }

  /**
   * Ask for one line of text; `secret` masks the entry (a provider key, a
   * token).
   */
  input(field: InputField): Effect.Effect<string | undefined, HostFailed> {
    return openDialog<string>('input', (answer) => (
      <TextEntryForm
        title={field.prompt}
        masked={field.secret ?? false}
        placeholder={field.placeholder ?? ''}
        hint="Press Enter to submit."
        onSubmit={answer}
        onCancel={() => answer(undefined)}
      />
    ));
  }
}

/** The process's one instance, shared by every TUI surface that presents. */
export const tuiUi = new TuiUiHost();
