// The chat TUI's one foreground form slot, and its only writer.
//
// Two surfaces put a form on screen: a slash command's own form
// (`openRegisteredCliSlashForm`) and a host dialog opened through
// `tuiUiHost`. Both used to write the signal directly, so whichever arrived
// second unmounted the first and threw away whatever the user had typed into
// it, and a displaced dialog was left with no form to answer its fiber
// (#12908). They go through the owner below instead, which keeps the forms
// that did not get the slot in arrival order and hands it on as each closes.

import { signal, type Signal } from '@lit-labs/signals';

import { registerCliStateResetHook } from './cliState';

/** Active inline slash form, or `undefined` when the chat input owns the
 *  screen. The form's `onDone` closes the slot. Kept opaque (the form
 *  carries its own state) so the registry stays declarative. */
interface ActiveSlashForm {
  /** The entry's own identity, stamped when it enters the slot: App keys the
   *  mounted form on it, so a form never inherits another form's state. */
  readonly id: number;
  /** The slash command that mounted the form (for the header strip). */
  readonly commandName: string;
  /** Render the form body. Receives the close callback. */
  readonly render: (
    onDone: () => void,
    availableRows: number,
  ) => React.ReactNode;
}

export const activeForm: Signal.State<ActiveSlashForm | undefined> = signal<
  ActiveSlashForm | undefined
>(undefined);

/** Forms waiting for the slot, nearest first. */
const QUEUED_FORMS: ActiveSlashForm[] = [];

type FormRequest = Omit<ActiveSlashForm, 'id'>;
let nextFormId = 0;

/**
 * Show `form` once the slot is free. What a surface that arrives unbidden
 * uses: a host dialog has no claim on a foreground the user is already
 * working in, so it waits its turn behind whatever is there.
 */
export function openActiveForm(request: FormRequest): ActiveSlashForm {
  const form = { ...request, id: nextFormId++ };
  if (activeForm.get() === undefined) activeForm.set(form);
  else QUEUED_FORMS.push(form);
  return form;
}

/**
 * Show `form` now, putting the form it displaces first in line to come back.
 * What the user's own slash command uses: the command they just ran is the
 * foreground they asked for, and the displaced form returns when it closes
 * rather than being dropped.
 */
export function takeActiveForm(request: FormRequest): void {
  const displaced = activeForm.get();
  if (displaced) QUEUED_FORMS.unshift(displaced);
  activeForm.set({ ...request, id: nextFormId++ });
}

/**
 * Give the slot up, from the form holding it or from one still waiting. A
 * form that already lost the slot clears nothing: only the occupant hands it
 * on, so a close arriving late from an in-flight operation cannot unmount
 * whatever is showing now.
 */
export function closeActiveForm(form: ActiveSlashForm): void {
  const queued = QUEUED_FORMS.indexOf(form);
  if (queued >= 0) {
    QUEUED_FORMS.splice(queued, 1);
    return;
  }
  if (activeForm.get() !== form) return;
  activeForm.set(QUEUED_FORMS.shift());
}

registerCliStateResetHook(() => {
  QUEUED_FORMS.length = 0;
  activeForm.set(undefined);
});
