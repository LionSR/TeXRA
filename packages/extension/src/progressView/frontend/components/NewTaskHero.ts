/**
 * The New-task hero once setup is done: the question and the project. The
 * composer below it is where the user describes the task.
 */

import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';

/** The hero card's layout, shared with the setup hero `<progress-app>`
 *  renders itself. */
export const heroStyles = css`
  .hero {
    display: grid;
    justify-items: center;
    gap: var(--wa-space-2xs);
    padding: 0 var(--wa-space-xs);
    text-align: center;
  }

  .hero-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: var(--wa-border-radius-l);
    border: var(--border-thin) solid var(--wa-color-brand-border-quiet);
    background: var(--wa-color-brand-fill-quiet);
    color: var(--wa-color-brand-on-quiet);
    font-size: 18px;
  }

  .hero h1 {
    margin: var(--wa-space-3xs) 0 0;
    font-size: var(--font-size-h2, 1.25em);
    font-weight: var(--font-weight-semibold);
    letter-spacing: -0.005em;
    line-height: var(--line-height-heading, 1.25);
  }

  .hero p {
    margin: 0;
    max-width: 34ch;
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal, 1.5);
    color: var(--color-text-secondary);
  }

  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--wa-space-2xs);
    margin-top: var(--wa-space-2xs);
  }
`;

@customElement('new-task-hero')
export class NewTaskHero extends LitElement {
  static override styles = [
    designTokens,
    heroStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  @property({ attribute: false }) projectName = '';

  override render(): TemplateResult {
    return html`<section class="hero" aria-labelledby="new-task-hero-title">
      <div class="hero-mark" aria-hidden="true">
        ${waIcon('wand-magic-sparkles')}
      </div>
      <h1 id="new-task-hero-title">What are you working on?</h1>
      <p>Describe the outcome you want for ${this.projectName}.</p>
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'new-task-hero': NewTaskHero;
  }
}
