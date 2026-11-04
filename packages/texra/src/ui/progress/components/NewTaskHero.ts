/**
 * The New-task hero once setup is done: the question and the project. The
 * composer below it is where the user describes the task.
 */

import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens } from '@ui/styles';

/** The hero card's layout, shared with the setup hero `<progress-app>`
 *  renders itself. */
export const heroStyles = css`
  .hero {
    display: grid;
    justify-items: var(--hero-align, center);
    gap: var(--wa-space-xs);
    padding: 0 var(--hero-padding-inline, var(--wa-space-xs));
    text-align: var(--hero-text-align, center);
  }

  .hero-mark {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: var(--wa-color-brand-on-quiet);
    font-size: 20px;
  }

  .hero h1 {
    margin: var(--wa-space-3xs) 0 0;
    font-size: var(--hero-heading-size, var(--font-size-h1));
    font-weight: var(--font-weight-semibold);
    letter-spacing: -0.025em;
    line-height: var(--line-height-heading, 1.25);
    text-wrap: balance;
  }

  .hero p {
    margin: 0;
    max-width: 52ch;
    font-size: var(--font-size);
    line-height: var(--line-height-normal, 1.5);
    color: var(--color-text-secondary);
    text-wrap: pretty;
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
      <h1 id="new-task-hero-title">What would you like to do?</h1>
      <p>Work with TeXRA on ${this.projectName}.</p>
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'new-task-hero': NewTaskHero;
  }
}
