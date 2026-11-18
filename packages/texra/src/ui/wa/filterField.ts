// The filter box above a list: a compact search field with the magnifier at
// its start and a clear button once it holds text. Rows are kept by
// `matchesQuery` (./listInteraction).

import { html, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

import { waIcon } from './webAwesomeIcons';

interface FilterField {
  /** Names the field and is its placeholder. */
  readonly label: string;
  readonly value: string;
  /** Every edit, the clear button's included. */
  readonly onInput: (value: string) => void;
}

/** The value is bound `live`, so a query the owner resets is shown even
 *  when it last rendered the same string. */
export function renderFilterField(field: FilterField): TemplateResult {
  return html`<wa-input
    size="s"
    with-clear
    placeholder=${field.label}
    aria-label=${field.label}
    .value=${live(field.value)}
    @input=${(event: Event) => {
      if (event.currentTarget instanceof WaInput)
        field.onInput(event.currentTarget.value ?? '');
    }}
    >${waIcon('magnifying-glass', { slot: 'start' })}</wa-input
  >`;
}
