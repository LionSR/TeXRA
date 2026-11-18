// The filter box above a list: a compact search field with the magnifier at
// its start and a clear button once it holds text. Rows are kept by
// `matchesQuery` (./listInteraction).

import { html, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

import { waIcon } from './webAwesomeIcons';

interface FilterField {
  /** Names the field's input; hidden, since the list says what it holds. */
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  /** Every edit, the clear button's included. */
  readonly onInput: (value: string) => void;
}

/** The value is bound `live`, so a query the owner resets is shown even
 *  when it last rendered the same string. */
export function renderFilterField(field: FilterField): TemplateResult {
  return html`<wa-input
    class="has-hidden-label"
    size="s"
    with-clear
    label=${field.label}
    placeholder=${field.placeholder}
    .value=${live(field.value)}
    @input=${(event: Event) => {
      if (event.currentTarget instanceof WaInput)
        field.onInput(event.currentTarget.value ?? '');
    }}
    >${waIcon('magnifying-glass', { slot: 'start' })}</wa-input
  >`;
}
