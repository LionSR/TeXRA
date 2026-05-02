/**
 * PlanView component — renders a structured implementation plan
 * with numbered steps, descriptions, file references, and status indicators.
 */

// Third-party imports
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - shared styles
import {
  designTokens,
  animationStyles,
  commonViewStyles,
} from '@shared/styles';
import {
  TODO_STATUS,
  STATUS_ICONS,
  type Plan,
  type PlanStep,
} from '@shared/schemas';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

@customElement('plan-view')
export class PlanView extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    animationStyles,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .plan-collapsible {
        border-bottom: var(--border-thin) solid var(--color-border);
      }

      .plan-collapsible::part(body) {
        max-height: var(--height-xlarge);
        overflow-y: auto;
      }

      .plan-summary {
        font-size: var(--font-size);
        line-height: var(--line-height-normal);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
      }

      .plan-steps {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-tiny);
      }

      .plan-step {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
        font-size: var(--font-size);
        line-height: var(--line-height-normal);
      }

      .plan-step__number {
        flex-shrink: 0;
        font-size: var(--font-size-sm);
        min-width: 1.4em;
        text-align: right;
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
        margin-top: var(--border-thin);
      }

      .plan-step__icon {
        flex-shrink: 0;
        font-size: var(--font-size-icon-sm);
        line-height: var(--line-height-normal);
        margin-top: var(--border-thin);
      }

      .plan-step__body {
        flex: 1;
        min-width: 0;
      }

      .plan-step__title {
        font-weight: var(--font-weight-medium);
        word-break: break-word;
      }

      .plan-step__description {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        margin-top: var(--spacing-tiny);
        word-break: break-word;
      }

      .plan-step__files {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-tiny);
        margin-top: var(--spacing-small);
      }

      .plan-step__file {
        font-size: var(--font-size-sm);
        color: var(--texra-textLink-foreground);
        background: var(--texra-badge-background);
        padding: var(--border-thin) var(--spacing-medium);
        border-radius: var(--border-radius);
        font-family: var(--texra-editor-font-family, monospace), monospace;
      }

      /* Status-specific styles */
      .plan-step--pending {
        opacity: var(--opacity-subtle);
      }

      .plan-step--pending .plan-step__icon {
        color: var(--color-text-secondary);
      }

      .plan-step--in-progress .plan-step__icon {
        color: var(--texra-progressBar-background);
      }

      .plan-step--in-progress .plan-step__title {
        color: var(--texra-progressBar-background);
      }

      .plan-step--completed {
        opacity: var(--opacity-disabled);
      }

      .plan-step--completed .plan-step__icon {
        color: var(--color-success);
      }

      .plan-step--completed .plan-step__title {
        text-decoration: line-through var(--color-text-secondary);
      }
    `,
  ];

  @property({ attribute: false }) plan: Plan | null = null;

  /** When this key changes, the panel collapses. Used by the parent to reset
   *  open state on context switches (e.g. switching streams). */
  @property({ type: String }) collapseKey = '';

  @state() private open = false;

  protected override willUpdate(changed: PropertyValues): void {
    if (
      changed.has('collapseKey') &&
      changed.get('collapseKey') !== undefined
    ) {
      this.open = false;
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.plan) {
      return nothing;
    }

    const completed = this.plan.steps.filter(
      (s) => s.status === TODO_STATUS.COMPLETED,
    ).length;
    const total = this.plan.steps.length;

    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.PLAN_VIEW_CONTAINER}
        class="plan-collapsible panel-collapsible"
        title=${`Plan (${completed}/${total})`}
        ?open=${this.open}
        @vsc-collapsible-toggle=${this.handleCollapsibleToggle}
      >
        <div class="plan-summary">${this.plan.summary}</div>
        <div id=${ELEMENT_IDS.PLAN_VIEW} class="plan-steps">
          ${repeat(
            this.plan.steps,
            (_step, index) => index,
            (step, index) => this.renderStep(step, index),
          )}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderStep(step: PlanStep, index: number): TemplateResult {
    const status = step.status ?? TODO_STATUS.PENDING;
    const isInProgress = status === TODO_STATUS.IN_PROGRESS;
    const icon = STATUS_ICONS[status] ?? STATUS_ICONS[TODO_STATUS.PENDING];

    return html`
      <div
        class=${classMap({
          'plan-step': true,
          'plan-step--pending': status === TODO_STATUS.PENDING,
          'plan-step--in-progress': status === TODO_STATUS.IN_PROGRESS,
          'plan-step--completed': status === TODO_STATUS.COMPLETED,
        })}
      >
        <span class="plan-step__number">${index + 1}.</span>
        <i
          class=${classMap({
            codicon: true,
            [`codicon-${icon}`]: true,
            'plan-step__icon': true,
            spin: isInProgress,
          })}
        ></i>
        <div class="plan-step__body">
          <div class="plan-step__title">${step.title}</div>
          <div class="plan-step__description">${step.description}</div>
          ${step.files.length > 0
            ? html`
                <div class="plan-step__files">
                  ${step.files.map(
                    (file) =>
                      html`<span class="plan-step__file">${file}</span>`,
                  )}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private handleCollapsibleToggle(e: CustomEvent<{ open?: boolean }>): void {
    this.open = e.detail?.open ?? this.open;
  }
}
