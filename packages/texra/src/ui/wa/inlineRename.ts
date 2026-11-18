// Third-party imports
import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { ref } from 'lit/directives/ref.js';

// Local imports
import { isCommitEnter } from './keyActivation';

interface InlineRenameField {
  readonly value: string;
  /** Accessible name of the field (there is no visible label). */
  readonly label: string;
  /** Placement class beside the shared `.inline-rename` skin. */
  readonly className: string;
  readonly maxLength?: number;
  /** The trimmed new text, when Enter or leaving the field saves a
   *  non-empty value other than `value`. */
  readonly onRename: (value: string) => void;
  /** The edit is over (saved, unchanged or cancelled): close the field. */
  readonly onClose: () => void;
}

/** Fields whose edit has finished: Enter closes the field, and removing it
 *  then blurs it, which must not finish the edit a second time. */
const finished = new WeakSet<EventTarget>();

// Lit sets the ref while the new template is still detached, so focusing
// waits until the field is in the document.
function focusAndSelect(element: Element | undefined): void {
  if (!(element instanceof HTMLInputElement)) return;
  queueMicrotask(() => {
    element.focus();
    element.select();
  });
}

/** Finish the field's edit once: save a changed value (`null` cancels),
 *  then close. */
function finish(field: InlineRenameField, event: Event, save: boolean): void {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || finished.has(input)) return;
  finished.add(input);
  const value = input.value.trim();
  if (save && value && value !== field.value) field.onRename(value);
  field.onClose();
}

/**
 * The one in-place rename field (task rows, the run header, desktop project
 * rows): focused with its text selected when it appears, Enter or leaving
 * saves, Esc cancels. Keys stay inside the field so row and view shortcuts
 * do not fire while typing.
 */
export function inlineRenameField(field: InlineRenameField): TemplateResult {
  return html`<input
    class="inline-rename ${field.className}"
    aria-label=${field.label}
    maxlength=${ifDefined(field.maxLength)}
    .value=${field.value}
    ${ref(focusAndSelect)}
    @keydown=${(event: KeyboardEvent) => {
      event.stopPropagation();
      if (isCommitEnter(event)) finish(field, event, true);
      else if (event.key === 'Escape') finish(field, event, false);
    }}
    @blur=${(event: FocusEvent) => finish(field, event, true)}
  />`;
}
