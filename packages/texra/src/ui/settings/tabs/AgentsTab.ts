/**
 * The Agents page, one section at a time: the skills (slot `skills`) the
 * settings app composes in, and Advanced, the session and multi-agent
 * coordination knobs.
 */

import { html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import {
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ALLOW_ORCHESTRATOR_KILL_SETTING,
  GIT_WORKTREE_SUPPORT_SETTING,
} from '@texra-ai/worldline/schemas';
import type { SettingsSectionName } from '@texra/shared/settingsView/settingsTarget';
import { TexraSignalElement } from '@ui/litBase';
import {
  renderStateSettingNumberRow,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';

@customElement('agents-tab')
export class AgentsTab extends TexraSignalElement {
  static override styles = [
    TexraSignalElement.styles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */

      ::slotted([slot='skills']) {
        display: block;
      }
    `,
  ];

  @property({ attribute: false }) section: SettingsSectionName<'agents'> =
    'skills';

  private renderSection(): TemplateResult {
    switch (this.section) {
      case 'skills':
        return html`<slot name="skills"></slot>`;
      case 'advanced':
        return this.renderAdvanced();
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="agents-container tab-content-container">
        ${this.renderSection()}
      </div>
    `;
  }

  private renderAdvanced(): TemplateResult {
    return html`
      <div class="settings-section">
        ${renderStateSettingNumberRow(MODEL_COMPACTION_THRESHOLD_SETTING, {
          unit: '%',
          // Clearing the field commits 0, which is the documented way to
          // disable compaction — not a no-op edit to be reverted.
          revertOnEmpty: false,
        })}
        ${renderStateSettingNumberRow(MODEL_RETRY_MAX_ATTEMPTS_SETTING, {
          step: 1,
          revertOnEmpty: false,
        })}
        ${renderStateSettingToggleRow(ALLOW_ORCHESTRATOR_KILL_SETTING)}
        ${renderStateSettingToggleRow(GIT_WORKTREE_SUPPORT_SETTING)}
        ${renderStateSettingNumberRow(CHILD_RUN_CONCURRENCY_BUDGET_SETTING, {
          step: 1,
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agents-tab': AgentsTab;
  }
}
