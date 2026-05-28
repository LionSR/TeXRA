// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { selectStyles } from '@shared/styles/selectStyles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

type Mode = 'chat' | 'agent';

/**
 * Visual-only mock of the post-workflow followup controls. Two modes —
 * "chat about the output" and "run another agent on the output" — with
 * a sample list of output files that the followup would inherit.
 */
@customElement('texra-followup-controls-mock')
export class FollowupControlsMock extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    selectStyles,
    css`
      :host {
        display: block;
      }

      .panel {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-s);
        padding: var(--wa-space-s);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--wa-border-radius-m);
        background: var(--wa-color-surface-default, transparent);
      }

      .header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }

      .header__title {
        font-weight: var(--font-weight-medium);
      }

      .header__caption {
        font-size: var(--font-size-small);
        color: var(--wa-color-text-quiet);
      }

      .files {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-3xs);
      }

      .file-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        padding: 2px var(--wa-space-2xs);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--wa-border-radius-s);
        font-size: var(--font-size-small);
        background: var(--wa-color-surface-raised, transparent);
      }

      .mode-row {
        display: flex;
        gap: var(--wa-space-2xs);
      }

      .mode-btn {
        flex: 1;
      }

      .mode-btn::part(base) {
        justify-content: flex-start;
        gap: var(--wa-space-2xs);
      }

      .mode-btn--active::part(base) {
        background: var(--wa-color-brand-fill-quiet);
        color: var(--wa-color-brand-on-quiet);
        border-color: var(--wa-color-brand-border-loud);
      }

      .form {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-2xs);
      }

      .form__row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: var(--wa-space-2xs);
      }

      .form__field {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
        min-width: 0;
      }

      .form__label {
        font-size: var(--font-size-small);
        color: var(--wa-color-text-quiet);
      }

      .form__textarea {
        width: 100%;
        min-height: 64px;
        font-family: inherit;
        font-size: var(--font-size);
        padding: var(--wa-space-2xs);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--wa-border-radius-s);
        background: var(--wa-color-surface-raised, transparent);
        color: var(--wa-color-text-normal);
        resize: vertical;
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--wa-space-2xs);
      }

      @media (max-width: 540px) {
        .form__row {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `,
  ];

  @state() private mode: Mode = 'chat';

  override render(): TemplateResult {
    return html`
      <div class="panel">
        <div class="header">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="check"
            variant="solid"
          ></wa-icon>
          <span class="header__title">Run complete — follow up?</span>
          <span class="header__caption">
            Picks up from this run's outputs without re-selecting files.
          </span>
        </div>

        <div class="files" aria-label="Output files from previous run">
          ${this.renderFileChip('manuscript_revised.tex')}
          ${this.renderFileChip('cover_letter.tex')}
          ${this.renderFileChip('response_to_reviewers.tex')}
        </div>

        <div class="mode-row" role="tablist" aria-label="Follow-up mode">
          ${this.renderModeButton('chat', 'comments', 'Chat about results')}
          ${this.renderModeButton('agent', 'robot', 'Run another agent')}
        </div>

        ${this.mode === 'chat'
          ? this.renderChatForm()
          : this.renderAgentForm()}
      </div>
    `;
  }

  private renderModeButton(
    mode: Mode,
    icon: string,
    label: string,
  ): TemplateResult {
    const active = this.mode === mode;
    return html`
      <wa-button
        class=${classMap({
          'mode-btn': true,
          'mode-btn--active': active,
        })}
        appearance=${active ? 'outlined' : 'plain'}
        size="small"
        role="tab"
        aria-selected=${active}
        @click=${() => (this.mode = mode)}
      >
        <wa-icon
          slot="start"
          library=${TEXRA_ICON_LIBRARY}
          name=${icon}
          variant="solid"
        ></wa-icon>
        ${label}
      </wa-button>
    `;
  }

  private renderFileChip(name: string): TemplateResult {
    return html`
      <span class="file-chip">
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name="file"
          variant="solid"
        ></wa-icon>
        ${name}
      </span>
    `;
  }

  private renderChatForm(): TemplateResult {
    return html`
      <div class="form">
        <div class="form__field">
          <label class="form__label" for="followup-chat-text">
            Ask about the revision
          </label>
          <textarea
            id="followup-chat-text"
            class="form__textarea"
            placeholder="e.g. Summarize what changed in the intro, and flag any leftover TODOs."
          ></textarea>
        </div>
        <div class="actions">
          <wa-button size="small" appearance="plain">Discard</wa-button>
          <wa-button size="small" appearance="accent">
            <wa-icon
              slot="start"
              library=${TEXRA_ICON_LIBRARY}
              name="paper-plane"
              variant="solid"
            ></wa-icon>
            Send
          </wa-button>
        </div>
      </div>
    `;
  }

  private renderAgentForm(): TemplateResult {
    return html`
      <div class="form">
        <div class="form__row">
          <div class="form__field">
            <label class="form__label" for="followup-agent">Agent</label>
            <wa-select
              id="followup-agent"
              size="small"
              value="merge"
              placeholder="Pick an agent"
            >
              <wa-option value="merge">merge</wa-option>
              <wa-option value="polish">polish</wa-option>
              <wa-option value="reflect">reflect</wa-option>
              <wa-option value="diff">latexdiff</wa-option>
            </wa-select>
          </div>
          <div class="form__field">
            <label class="form__label" for="followup-model">Model</label>
            <wa-select
              id="followup-model"
              size="small"
              value="claude-opus-4-7"
              placeholder="Pick a model"
            >
              <wa-option value="claude-opus-4-7">Claude Opus 4.7</wa-option>
              <wa-option value="claude-sonnet-4-6">Claude Sonnet 4.6</wa-option>
              <wa-option value="claude-haiku-4-5">Claude Haiku 4.5</wa-option>
            </wa-select>
          </div>
        </div>
        <div class="form__field">
          <label class="form__label" for="followup-agent-text">
            Instruction (optional)
          </label>
          <textarea
            id="followup-agent-text"
            class="form__textarea"
            placeholder="Extra direction for the agent. Output files are inherited automatically."
          ></textarea>
        </div>
        <div class="actions">
          <wa-button size="small" appearance="plain">Discard</wa-button>
          <wa-button size="small" appearance="accent">
            <wa-icon
              slot="start"
              library=${TEXRA_ICON_LIBRARY}
              name="play"
              variant="solid"
            ></wa-icon>
            Run merge
          </wa-button>
        </div>
      </div>
    `;
  }
}
