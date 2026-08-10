import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { ActiveSkillSummary } from '@shared/schemas';

@customElement('active-skills-details')
export class ActiveSkillsDetails extends LitElement {
  static override styles = css`
    :host,
    details,
    ul,
    li {
      min-width: 0;
    }

    :host {
      display: contents;
    }

    details {
      box-sizing: border-box;
      max-width: 100%;
      overflow: hidden;
      margin: 0 0 var(--wa-space-xs);
      padding: var(--wa-space-2xs) var(--wa-space-xs);
      border: 1px solid var(--wa-color-neutral-border-quiet);
      border-radius: var(--wa-border-radius-m);
      color: var(--wa-color-text-normal);
      font-size: var(--wa-font-size-s);
    }

    summary {
      cursor: pointer;
      font-weight: var(--font-weight-semibold, 600);
    }

    ul {
      display: grid;
      gap: var(--wa-space-2xs);
      margin: var(--wa-space-xs) 0 0;
      padding-inline-start: var(--wa-space-l);
    }

    li {
      overflow-wrap: anywhere;
    }

    .source {
      color: var(--wa-color-text-quiet);
    }
  `;

  @property({ attribute: false })
  skills: readonly ActiveSkillSummary[] = [];

  override render(): TemplateResult | typeof nothing {
    if (this.skills.length === 0) return nothing;
    return html`
      <details>
        <summary>Skills (${this.skills.length})</summary>
        <ul>
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
      </details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'active-skills-details': ActiveSkillsDetails;
  }
}
