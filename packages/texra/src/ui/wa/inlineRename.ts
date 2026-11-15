// Third-party imports
import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { ref } from 'lit/directives/ref.js';

interface InlineRenameField {
  readonly value: string;
  /** Accessible name of the field (there is no visible label). */
  readonly label: string;
  /** Placement class beside the shared `.inline-rename` skin. */
  readonly className: string;
  readonly maxLength?: number;
  /** The typed text on Enter or when the field loses focus; `null` on Esc.
   *  Both can fire for one edit (Enter, then the blur of the removed field),
   *  so the caller ignores a finish once it has closed the field. */
  readonly onFinish: (value: string | null) => void;
}

// Lit sets the ref while the new template is still detached, so focusing
// waits until the field is in the document.
function focusAndSelect(element: Element | undefined): void {
  if (!(element instanceof HTMLInputElement)) return;
  queueMicrotask(() => {
    element.focus();
    element.select();
  });
}

function inputValue(event: Event): string | null {
  const input = event.currentTarget;
  return input instanceof HTMLInputElement ? input.value : null;
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
      if (event.key === 'Enter') field.onFinish(inputValue(event));
      else if (event.key === 'Escape') field.onFinish(null);
    }}
    @blur=${(event: FocusEvent) => field.onFinish(inputValue(event))}
  />`;
}
