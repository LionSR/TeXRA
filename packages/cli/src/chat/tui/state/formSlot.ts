// The chat TUI's one foreground form slot, and its only writer.
//
// Two surfaces put a form on screen: a slash command's own form
// (`openRegisteredCliSlashForm`) and a host dialog opened through
// `tuiUiHost`. Both used to write the signal directly, so whichever arrived
// second unmounted the first and threw away whatever the user had typed into
// it, and a displaced dialog was left with no form to answer its fiber.
// They go through the owner below instead, which keeps the forms
// that did not get the slot in arrival order and hands it on as each closes.

import { randomUUID } from 'node:crypto';

import { computed } from '@lit-labs/signals';

import { chatField } from './cliState';

/** Active inline slash form, or `undefined` when the chat input owns the
 *  screen. The form's `onDone` closes the slot. Kept opaque (the form
 *  carries its own state) so the registry stays declarative. */
interface ActiveSlashForm {
  /** The entry's own identity, stamped when it enters the slot: App keys the
   *  mounted form on it, so a form never inherits another form's state. */
  readonly id: string;
  /** The slash command that mounted the form (for the header strip). */
  readonly commandName: string;
  /** Render the form body. Receives the close callback. */
  readonly render: (
    onDone: () => void,
    availableRows: number,
  ) => React.ReactNode;
}

/** The slot's occupant, and the forms waiting for it, nearest first: the
 *  chat's state, so a new conversation starts with the slot free. */
export interface FormSlot {
  readonly active: ActiveSlashForm | undefined;
  readonly queued: readonly ActiveSlashForm[];
}

const slot = chatField('forms');

export const activeForm = computed(() => slot.get().active);

type FormRequest = Omit<ActiveSlashForm, 'id'>;

/**
 * Show `form` once the slot is free. What a surface that arrives unbidden
 * uses: a host dialog has no claim on a foreground the user is already
 * working in, so it waits its turn behind whatever is there.
 */
export function openActiveForm(request: FormRequest): ActiveSlashForm {
  const form = { ...request, id: randomUUID() };
  const { active, queued } = slot.get();
  slot.set(
    active === undefined
      ? { active: form, queued }
      : { active, queued: [...queued, form] },
  );
  return form;
}

/**
 * Show `form` now, putting the form it displaces first in line to come back.
 * What the user's own slash command uses: the command they just ran is the
 * foreground they asked for, and the displaced form returns when it closes
 * rather than being dropped.
 */
export function takeActiveForm(request: FormRequest): void {
  const { active, queued } = slot.get();
  slot.set({
    active: { ...request, id: randomUUID() },
    queued: active === undefined ? queued : [active, ...queued],
  });
}

/**
 * Give the slot up, from the form holding it or from one still waiting. A
 * form that already lost the slot clears nothing: only the occupant hands it
 * on, so a close arriving late from an in-flight operation cannot unmount
 * whatever is showing now.
 */
export function closeActiveForm(form: ActiveSlashForm): void {
  const { active, queued } = slot.get();
  if (queued.includes(form)) {
    slot.set({ active, queued: queued.filter((waiting) => waiting !== form) });
    return;
  }
  if (active !== form) return;
  const [next, ...rest] = queued;
  slot.set({ active: next, queued: rest });
}
