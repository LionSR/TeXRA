/**
 * `<model-picker>`: the composer's model choice. Its chip names the model and its reasoning
 * level; its panel searches the host's models and sets the level. It owns
 * no selection: every pick goes out as `model-pick` with the model string
 * to run (`provider/id[@effort]`), and a level is also remembered for its
 * model (`setReasoningLevel`), so returning to a model returns to its level.
 */

// Third-party imports
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/popover/popover.js';

// Local imports
import {
  nearestEffort,
  selectModel,
  type ReasoningEffort,
} from '@texra-ai/llm';
import {
  getModelLabel,
  isModelOptionAvailable,
} from '@texra-ai/worldline/schemas';
import { REASONING_LEVEL_LABELS } from '@texra/shared/model/modelPicker';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import { TexraElement } from '@ui/litBase';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { truncateDeclarations } from '@ui/styles/commonViewStyles';
import { popoverPanelStyles } from '@ui/styles/overlaySurfaceStyles';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { isCommitEnter } from '@ui/wa/keyActivation';
import {
  listMoveOfKey,
  matchesQuery,
  nextListIndex,
} from '@ui/wa/listInteraction';
import { waIcon } from '@ui/wa/webAwesomeIcons';

/** One row of a model choice: a host row, or the selected model as itself. */
interface ModelChoice {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  /** The host's row; absent for a model the host does not list. */
  readonly row?: ModelOptionData;
}

/** The model a string names without its effort or mode, for matching rows. */
const refOf = (model: string): string =>
  selectModel(model)?.config.ref ?? model;

/**
 * The models a choice offers over `selected`: the host's rows, the one
 * `selected` names among them whatever effort it carries. A model the host
 * does not list (a proposal's, say) leads the list as itself.
 */
function modelChoices(
  selected: string,
  rows: readonly ModelOptionData[],
): { readonly current: ModelChoice; readonly choices: readonly ModelChoice[] } {
  const listed = rows.map((row) => ({
    value: row.value,
    label: row.label,
    disabled: !isModelOptionAvailable(row),
    row,
  }));
  const ref = refOf(selected);
  const current = listed.find((choice) => refOf(choice.value) === ref);
  if (current !== undefined) return { current, choices: listed };
  const own: ModelChoice = {
    value: selected,
    label: getModelLabel(selected),
    disabled: false,
  };
  return { current: own, choices: [own, ...listed] };
}

/** The level `selected` runs at: the one it names, as the model's nearest
 *  level when the model lacks it (as the run sends it), else what its row
 *  sends. */
function levelOf(
  selected: string,
  current: ModelChoice,
): ReasoningEffort | undefined {
  const named = selectModel(selected)?.request.effort;
  const levels = current.row?.efforts?.levels;
  if (named === undefined) return current.row?.efforts?.sent;
  return levels === undefined ? named : nearestEffort(levels, named);
}

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
    popoverPanelStyles,
    css`
      :host {
        --popover-panel-width: 20rem;
        display: inline-flex;
        min-width: 0;
      }
      .chip-effort {
        color: var(--color-text-secondary);
      }
      .popover-panel {
        display: flex;
        flex-direction: column;
        max-height: min(24rem, 70vh);
      }
      .search {
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
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        width: 100%;
        min-height: var(--row-height);
        padding: 0 var(--wa-space-xs);
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
        color: var(--color-text-secondary);
        cursor: not-allowed;
      }
      .choice-name {
        flex: 1 1 auto;
        min-width: 0;
        ${truncateDeclarations}
      }
      .choice-check {
        flex: none;
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
        padding: var(--wa-space-2xs);
        border-block-start: var(--border-thin) solid var(--color-border);
      }
      .levels {
        display: flex;
        flex-wrap: wrap;
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
    const query = this.searchText.trim();
    return choices.filter((choice) =>
      matchesQuery(
        // Model names and ids are ASCII: fold them without the locale, so
        // a Turkish locale's dotless i does not hide "OpenAI" from "openai".
        `${choice.label} ${choice.value} ${choice.row?.provider ?? ''}`.toLowerCase(),
        query,
      ),
    );
  }

  /** Another model, at the level remembered for it (its row's), or its
   *  default. */
  private pick(choice: ModelChoice): void {
    if (choice.disabled) return;
    this.dispatchEvent(
      new CustomEvent<string>('model-pick', { detail: choice.value }),
    );
    void this.panel?.hide();
  }

  /** The selected model at `level`, keeping the mode it carries. */
  /** The selected model at `level`: this task takes it now, and the model
   *  remembers it for the next one. */
  private setLevel(current: ModelChoice, level: ReasoningEffort): void {
    const ref = refOf(current.value);
    const mode = selectModel(this.selected)?.request.mode;
    this.dispatchEvent(
      new CustomEvent<string>('model-pick', {
        detail: `${ref}@${level}${mode ? `+${mode}` : ''}`,
      }),
    );
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'setReasoningLevel', model: ref, level }),
    );
  }

  /** The search keeps Home and End for its caret; the arrows move. */
  private onSearchKey(event: KeyboardEvent, shown: readonly ModelChoice[]) {
    if (isCommitEnter(event)) {
      event.preventDefault();
      const choice = shown.at(this.active);
      if (choice !== undefined) this.pick(choice);
      return;
    }
    const move = listMoveOfKey(event.key, 'vertical');
    if (move !== 'next' && move !== 'previous') return;
    event.preventDefault();
    this.active = Math.max(0, nextListIndex(move, this.active, shown.length));
  }

  protected override updated(): void {
    this.renderRoot
      .querySelector('.choice.is-active')
      ?.scrollIntoView({ block: 'nearest' });
  }

  private renderChoice(
    choice: ModelChoice,
    index: number,
    current: ModelChoice,
  ): TemplateResult {
    const chosen = choice === current;
    return html`<button
      type="button"
      role="option"
      class=${classMap({ choice: true, 'is-active': index === this.active })}
      aria-selected=${chosen}
      title=${choice.row?.unavailableReason ?? ''}
      ?disabled=${choice.disabled}
      @pointermove=${() => {
        this.active = index;
      }}
      @click=${() => this.pick(choice)}
    >
      <span class="choice-name">${choice.label}</span>
      ${chosen ? waIcon('check', { className: 'choice-check' }) : nothing}
    </button>`;
  }

  /** The selected model's levels, where its route offers a choice. */
  private renderLevels(current: ModelChoice): TemplateResult | typeof nothing {
    const efforts = current.row?.efforts;
    if (efforts === undefined) return nothing;
    const sent = levelOf(this.selected, current);
    return html`<div class="foot">
      <div class="levels" role="radiogroup" aria-label="Reasoning level">
        ${efforts.levels.map(
          (level) =>
            html`<button
              type="button"
              role="radio"
              class="level"
              aria-checked=${level === sent}
              @click=${() => this.setLevel(current, level)}
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
    const sent = levelOf(this.selected, current);
    // A selection in pro mode runs differently, so the chip says so.
    const pro = selectModel(this.selected)?.request.mode === 'pro';
    return html`
      ${renderLabeledActionButton({
        id: 'composer-model',
        kind: 'ghost',
        className: 'chip-trigger is-compact',
        // prettier-ignore
        text: html`<span class="chip-label">${current.label}${sent === undefined ? nothing : html` <span class="chip-effort">${REASONING_LEVEL_LABELS[sent]}</span>`}${pro ? html` <span class="chip-effort">Pro</span>` : nothing}</span>`,
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
          this.active = Math.max(0, choices.indexOf(current));
        }}
        @wa-after-show=${() => this.search?.focus()}
        @wa-after-hide=${() => {
          this.searchText = '';
          this.active = 0;
        }}
      >
        <div class="popover-panel">
          <label class="search popover-panel-head">
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
                    (choice, index) =>
                      this.renderChoice(choice, index, current),
                  )
            }
          </div>
          ${this.renderLevels(current)}
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
