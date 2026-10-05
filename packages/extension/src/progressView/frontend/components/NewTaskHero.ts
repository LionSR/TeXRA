/**
 * The New-task hero once setup is done: the question, the project, and the
 * starter prompts. A starter fills the launcher's instruction and hands the
 * caret to the composer; it never sends, so the user edits before anything
 * runs. The starters leave once the instruction has text, since a click
 * would overwrite what the user wrote.
 */

import '@awesome.me/webawesome/dist/components/button/button.js';
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { SessionUiEvents } from '@shared/session/uiEvents';
import { NEW_TASK_STARTERS } from '@ui/copy/newTaskStarters';
import { designTokens } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';

import type { SessionComposer } from './SessionComposer';

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

  .hero-starters {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--wa-space-2xs);
    margin-top: var(--wa-space-xs);
  }

  .hero-starter::part(base) {
    border-radius: var(--wa-border-radius-pill);
    font-weight: var(--font-weight-normal, 400);
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
  @property({ attribute: false }) instruction = '';

  private async useStarter(instruction: string): Promise<void> {
    this.dispatchEvent(
      SessionUiEvents.surface({ kind: 'launch', patch: { instruction } }),
    );
    // The composer is this hero's sibling in the app's shadow root; it
    // renders the new text on the app's next update.
    await new Promise(requestAnimationFrame);
    const composer = (
      this.getRootNode() as ParentNode
    ).querySelector<SessionComposer>('session-composer.launch-composer');
    await composer?.updateComplete;
    composer?.focusAtEnd();
  }

  override render(): TemplateResult {
    return html`<section class="hero" aria-labelledby="new-task-hero-title">
      <div class="hero-mark" aria-hidden="true">
        ${waIcon('wand-magic-sparkles')}
      </div>
      <h1 id="new-task-hero-title">What are you working on?</h1>
      <p>
        Describe the outcome you want for ${this.projectName}, or start from one
        of these.
      </p>
      ${
        this.instruction.trim() === ''
          ? html`<div class="hero-starters" role="group" aria-label="Starters">
              ${NEW_TASK_STARTERS.map(
                (starter) =>
                  html`<wa-button
                    class="hero-starter"
                    appearance="outlined"
                    size="s"
                    @click=${() => void this.useStarter(starter.instruction)}
                    >${waIcon(starter.icon, { slot: 'start' })}${starter.label}</wa-button
                  >`,
              )}
            </div>`
          : nothing
      }
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'new-task-hero': NewTaskHero;
  }
}
