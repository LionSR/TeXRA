/**
 * ActiveSkillsDetails — collapsible panel listing skills active for a run.
 * Extends CollapsiblePanel so stream switches reset open state via collapseKey.
 */

// Third-party imports
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import type { ActiveSkillSummary } from '@shared/schemas';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Local imports - base class
import { CollapsiblePanel } from './CollapsiblePanel';

@customElement('active-skills-details')
export class ActiveSkillsDetails extends CollapsiblePanel {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
        min-width: 0;
      }

      .skills-list {
        display: grid;
        gap: var(--wa-space-2xs);
        margin: 0;
        padding-inline-start: var(--wa-space-l);
        min-width: 0;
      }

      .skills-list li {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .source {
        color: var(--wa-color-text-quiet);
      }
    `,
  ];

  @property({ attribute: false })
  skills: readonly ActiveSkillSummary[] = [];

  override render(): TemplateResult | typeof nothing {
    if (this.skills.length === 0) return nothing;

    return this.renderCollapsibleDetails({
      id: ELEMENT_IDS.ACTIVE_SKILLS_CONTAINER,
      summary: `Skills (${this.skills.length})`,
      body: html`
        <ul id=${ELEMENT_IDS.ACTIVE_SKILLS_LIST} class="skills-list">
          ${this.skills.map(
            (skill) => html`
              <li>
                <strong>${skill.name}</strong>
                <span class="source">(${skill.source})</span>
                ${skill.description}
              </li>
            `,
          )}
        </ul>
      `,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'active-skills-details': ActiveSkillsDetails;
  }
}
