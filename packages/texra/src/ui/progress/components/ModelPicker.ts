/**
 * `<model-picker>`: the composer's model choice. Its chip names the model
 * and the reasoning level a run sends; its panel searches the host's models,
 * says what each is for, and sets the selected model's reasoning level.
 * It owns no selection: a pick goes out as `model-pick`, a level as the
 * host's `setReasoningLevel`, and the chip follows the rows it is given.
 */

// Third-party imports
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/popover/popover.js';

// Local imports
import { modelRefOf, type ReasoningEffort } from '@texra-ai/llm';
import {
  getModelLabel,
  isModelOptionAvailable,
  joinFacts,
} from '@texra-ai/worldline/schemas';
import { REASONING_LEVEL_LABELS } from '@texra/shared/model/modelPicker';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import { TexraElement } from '@ui/litBase';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { truncateDeclarations } from '@ui/styles/commonViewStyles';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';

/** One row of a model choice: a host row, or the selected model as itself. */
export interface ModelChoice {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  /** The host's row; absent for a model the host does not list. */
  readonly row?: ModelOptionData;
}

/**
 * The models a choice offers over `selected`: the host's rows, the selected
 * one among them. A model the host does not list (a saved effort or mode,
 * or a proposal's model) leads the list as itself, its effort or mode after
 * the name: `ref@high` is "Name (high)".
 */
export function modelChoices(
  selected: string,
  rows: readonly ModelOptionData[],
): { readonly current: ModelChoice; readonly choices: readonly ModelChoice[] } {
  const listed = rows.map((row) => ({
    value: row.value,
    label: row.label,
    disabled: !isModelOptionAvailable(row),
    row,
  }));
  const current = listed.find((choice) => choice.value === selected);
  if (current !== undefined) return { current, choices: listed };
  const ref = modelRefOf(selected) ?? selected;
  const modifiers = selected.slice(ref.length).replace(/^[@+]/, '');
  const own: ModelChoice = {
    value: selected,
    label:
      modifiers === ''
        ? getModelLabel(selected)
        : `${getModelLabel(selected)} (${modifiers})`,
    disabled: false,
  };
  return { current: own, choices: [own, ...listed] };
}

/** What a row says under its name: why it cannot run, else what it is for,
 *  else its facts. */
function describe(row: ModelOptionData | undefined): string {
  if (row === undefined) return '';
  return (
    row.unavailableReason ??
    row.hint ??
    joinFacts([row.routeLabel, row.context && `${row.context} context`])
  );
}

const matches = (choice: ModelChoice, query: string): boolean =>
  `${choice.label} ${choice.value} ${choice.row?.provider ?? ''}`
    .toLowerCase()
    .includes(query);

/** A composer chip's trigger, shared with the composer's other chips. */
export const chipTriggerStyles = css`
  .chip-trigger {
    flex: none;
    max-width: 100%;
  }
  .chip-trigger::part(label) {
    min-width: 0;
  }
  .chip-trigger::part(base) {
    gap: var(--wa-space-2xs);
    padding-inline: var(--wa-space-xs);
    font-size: var(--font-size-sm);
    border-radius: var(--field-radius);
  }
  .chip-trigger wa-icon {
    flex: none;
    font-size: var(--font-size-sm);
  }
  .chip-trigger::part(caret) {
    flex: none;
  }
  .chip-label {
    display: block;
    max-width: 22ch;
    ${truncateDeclarations}
  }
`;

@customElement('model-picker')
export class ModelPicker extends TexraElement {
  static override styles = [
    TexraElement.styles,
    chipTriggerStyles,
    css`
      :host {
        display: inline-flex;
        min-width: 0;
      }
      .chip-effort {
        color: var(--color-text-secondary);
      }
      wa-popover {
        --arrow-size: 0;
        --max-width: min(26rem, calc(100vw - 2 * var(--wa-space-m)));
      }
      wa-popover::part(body) {
        padding: 0;
      }
      .panel {
        display: flex;
        flex-direction: column;
        width: min(26rem, calc(100vw - 2 * var(--wa-space-m)));
        max-height: min(28rem, 70vh);
        font-size: var(--font-size-sm);
      }
      .search {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        padding: var(--wa-space-xs) var(--wa-space-s);
        border-block-end: var(--border-thin) solid var(--color-border);
        color: var(--color-text-secondary);
      }
      .search input {
        flex: 1;
        min-width: 0;
        border: 0;
        outline: none;
        background: transparent;
        color: var(--wa-color-text-normal);
        font: inherit;
        font-size: var(--font-size);
      }
      .rows {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: var(--wa-space-2xs);
        scrollbar-width: thin;
      }
      .choice {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        column-gap: var(--wa-space-xs);
        width: 100%;
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        border: 0;
        border-radius: var(--field-radius);
        background: transparent;
        color: var(--wa-color-text-normal);
        font: inherit;
        text-align: start;
        cursor: pointer;
      }
      .choice.is-active {
        background: var(--surface-hover);
      }
      .choice:disabled {
        cursor: not-allowed;
      }
      .choice:disabled .choice-name {
        color: var(--color-text-secondary);
      }
      .choice-name {
        font-weight: var(--font-weight-medium);
        ${truncateDeclarations}
      }
      .choice-about {
        grid-column: 1;
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        line-height: var(--line-height-normal);
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }
      .choice-cost {
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .choice-check {
        grid-column: 2;
        grid-row: 2;
        justify-self: end;
        color: var(--color-text-secondary);
      }
      .none {
        padding: var(--wa-space-s);
        color: var(--color-text-secondary);
      }
      .foot {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        padding: var(--wa-space-2xs) var(--wa-space-s);
        border-block-start: var(--border-thin) solid var(--color-border);
      }
      .foot-label {
        color: var(--color-text-secondary);
        margin-inline-end: auto;
      }
      .levels {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: var(--wa-space-3xs);
      }
      .level {
        padding: var(--wa-space-3xs) var(--wa-space-xs);
        border: 0;
        border-radius: var(--field-radius);
        background: transparent;
        color: var(--color-text-secondary);
        font: inherit;
        cursor: pointer;
      }
      .level:hover {
        background: var(--surface-hover);
      }
      .level[aria-checked='true'] {
        background: var(--wa-color-surface-raised);
        color: var(--wa-color-text-normal);
        font-weight: var(--font-weight-medium);
      }
    `,
  ];

  /** The host's model rows. */
  @property({ attribute: false }) options: readonly ModelOptionData[] = [];
  /** The model in effect: the launch's, or the run's. */
  @property({ attribute: false }) selected = '';

  @state() private searchText = '';
  /** The row the arrow keys are on, an index into the filtered rows. */
  @state() private active = 0;

  @query('wa-popover') private panel?: HTMLElement & {
    hide(): Promise<void>;
  };
  @query('.search input') private search?: HTMLInputElement;

  private filtered(choices: readonly ModelChoice[]): readonly ModelChoice[] {
    const needle = this.searchText.trim().toLowerCase();
    return needle === ''
      ? choices
      : choices.filter((choice) => matches(choice, needle));
  }

  private pick(choice: ModelChoice): void {
    if (choice.disabled) return;
    this.dispatchEvent(
      new CustomEvent<string>('model-pick', { detail: choice.value }),
    );
    void this.panel?.hide();
  }

  private setLevel(model: string, level: ReasoningEffort): void {
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: 'setReasoningLevel',
        model: modelRefOf(model) ?? model,
        level,
      }),
    );
  }

  private onSearchKey(event: KeyboardEvent, shown: readonly ModelChoice[]) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + step + shown.length) % (shown.length || 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = shown.at(this.active);
      if (choice !== undefined) this.pick(choice);
    }
  }

  protected override updated(): void {
    this.renderRoot
      .querySelector('.choice.is-active')
      ?.scrollIntoView({ block: 'nearest' });
  }

  private renderChoice(choice: ModelChoice, index: number): TemplateResult {
    const chosen = choice.value === this.selected;
    return html`<button
      type="button"
      role="option"
      class=${classMap({ choice: true, 'is-active': index === this.active })}
      aria-selected=${chosen}
      ?disabled=${choice.disabled}
      @pointermove=${() => {
        this.active = index;
      }}
      @click=${() => this.pick(choice)}
    >
      <span class="choice-name">${choice.label}</span>
      <span class="choice-cost">${choice.row?.cost ?? ''}</span>
      <span class="choice-about">${describe(choice.row)}</span>
      ${chosen ? waIcon('check', { className: 'choice-check' }) : nothing}
    </button>`;
  }

  /** The selected model's levels, where its route offers a choice. */
  private renderLevels(current: ModelChoice): TemplateResult | typeof nothing {
    const efforts = current.row?.efforts;
    if (efforts === undefined) return nothing;
    return html`<div class="foot">
      <span class="foot-label" id="model-picker-levels">Reasoning</span>
      <div
        class="levels"
        role="radiogroup"
        aria-labelledby="model-picker-levels"
      >
        ${efforts.levels.map(
          (level) =>
            html`<button
              type="button"
              role="radio"
              class="level"
              aria-checked=${level === efforts.sent}
              @click=${() => this.setLevel(current.value, level)}
            >
              ${REASONING_LEVEL_LABELS[level]}
            </button>`,
        )}
      </div>
    </div>`;
  }

  override render(): TemplateResult {
    const { current, choices } = modelChoices(this.selected, this.options);
    const shown = this.filtered(choices);
    const sent = current.row?.efforts?.sent;
    return html`
      ${renderLabeledActionButton({
        id: 'composer-model',
        kind: 'ghost',
        className: 'chip-trigger is-compact',
        // prettier-ignore
        text: html`<span class="chip-label">${current.label}${sent === undefined ? nothing : html` <span class="chip-effort">${REASONING_LEVEL_LABELS[sent]}</span>`}</span>`,
        label: `Model: ${current.label}`,
        tooltip: 'Model',
        caret: true,
      })}
      <wa-popover
        for="composer-model"
        placement="top-start"
        distance="6"
        without-arrow
        @wa-show=${() => {
          // The arrow keys start from the model in effect.
          this.active = Math.max(
            0,
            choices.findIndex((choice) => choice.value === this.selected),
          );
        }}
        @wa-after-show=${() => this.search?.focus()}
        @wa-after-hide=${() => {
          this.searchText = '';
          this.active = 0;
        }}
      >
        <div class="panel">
          <label class="search">
            ${waIcon('magnifying-glass')}
            <input
              type="text"
              placeholder="Search models"
              aria-label="Search models"
              autocomplete="off"
              spellcheck="false"
              .value=${this.searchText}
              @input=${(event: InputEvent) => {
                if (!(event.target instanceof HTMLInputElement)) return;
                this.searchText = event.target.value;
                this.active = 0;
              }}
              @keydown=${(event: KeyboardEvent) =>
                this.onSearchKey(event, shown)}
            />
          </label>
          <div class="rows" role="listbox" aria-label="Models">
            ${
              shown.length === 0
                ? html`<div class="none">No model matches.</div>`
                : repeat(
                    shown,
                    (choice) => choice.value,
                    (choice, index) => this.renderChoice(choice, index),
                  )
            }
          </div>
          ${this.renderLevels(current)}
          <div class="foot">
            ${renderLabeledActionButton({
              text: 'Model settings…',
              kind: 'link',
              onClick: () => {
                void this.panel?.hide();
                this.dispatchEvent(
                  SessionUiEvents.host({
                    kind: 'openSettings',
                    target: 'models/models',
                  }),
                );
              },
            })}
          </div>
        </div>
      </wa-popover>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'model-picker': ModelPicker;
  }
}
