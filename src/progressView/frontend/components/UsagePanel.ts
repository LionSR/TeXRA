// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared styles
// Note: Design tokens from tokens.css are inherited into Shadow DOM via :root
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - shared schemas

// Local imports - progress view formatters
import { formatTokens } from '../formatters/timestampUtils';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';
import type { TokenUsageStats } from '@shared/schemas';
import type { ContextState } from '../store';

@customElement('usage-panel')
export class UsagePanel extends LitElement {
  static styles = [
    codiconIconClasses,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .usage-summary-footer {
        border-top: var(--border-thin) solid var(--color-border);
        background-color: var(--vscode-sideBarSectionHeader-background);
        padding: var(--spacing-small) var(--spacing-medium);
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .run-summary {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        opacity: 0.9;
        margin-left: auto;
      }

      .run-summary .codicon {
        font-size: var(--font-size-icon-sm);
        opacity: 0.75;
      }

      .run-summary__label {
        font-weight: 500;
        color: var(--color-text-secondary);
      }

      .run-summary__value {
        color: var(--vscode-foreground);
      }

      .context-state {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        opacity: 0.9;
      }

      .context-state .codicon {
        font-size: var(--font-size-icon-sm);
        opacity: 0.75;
      }

      .context-state__value {
        color: var(--vscode-foreground);
      }
    `,
  ];

  @property({ type: Object }) usage: TokenUsageStats | null = null;
  @property({ type: Object }) contextState: ContextState | null = null;

  render(): TemplateResult | typeof nothing {
    const hasUsage =
      (this.usage?.inputTokens ?? 0) > 0 ||
      (this.usage?.outputTokens ?? 0) > 0 ||
      (this.usage?.cost ?? 0) > 0;
    const hasContext =
      (this.contextState?.contextWindow ?? 0) > 0 &&
      this.contextState?.utilizationPercent !== undefined;

    if (!hasUsage && !hasContext) {
      return nothing;
    }

    return html`
      <div class="usage-summary-footer" ?hidden=${!hasUsage && !hasContext}>
        <span
          id=${ELEMENT_IDS.CONTEXT_STATE}
          class="context-state"
          ?hidden=${!hasContext}
        >
          ${this.renderContext()}
        </span>
        <span
          id=${ELEMENT_IDS.RUN_SUMMARY}
          class="run-summary"
          aria-label=${this.buildUsageLabel()}
        >
          ${this.renderUsage()}
        </span>
      </div>
    `;
  }

  private renderUsage(): TemplateResult | typeof nothing {
    if (!this.usage) return nothing;

    const inputTokens = this.usage.inputTokens ?? 0;
    const outputTokens = this.usage.outputTokens ?? 0;
    const cost = this.usage.cost ?? 0;
    const cacheRead = this.usage.cacheReadInputTokens ?? 0;
    const cacheWrite = this.usage.cacheCreationInputTokens ?? 0;

    return html`
      <i class="codicon codicon-meter"></i>
      <span class="run-summary__label">Total usage:</span>
      <span class="run-summary__value">
        <i class="codicon codicon-arrow-up" title="Input tokens"></i
        >${formatTokens(inputTokens)}
        ${when(
          cacheRead > 0,
          () =>
            html` ·
              <i
                class="codicon codicon-cloud-download"
                title="Cache read tokens (discounted)"
              ></i>
              ${formatTokens(cacheRead)}`,
        )}
        ${when(
          cacheWrite > 0,
          () =>
            html` ·
              <i
                class="codicon codicon-database"
                title="Cache creation tokens (1.25x cost)"
              ></i>
              ${formatTokens(cacheWrite)}`,
        )}
        ·
        <i class="codicon codicon-arrow-down" title="Output tokens"></i
        >${formatTokens(outputTokens)} · $${cost.toFixed(3)}
      </span>
    `;
  }

  private renderContext(): TemplateResult | typeof nothing {
    if (!this.contextState) return nothing;
    const { inputTokens, contextWindow, utilizationPercent } =
      this.contextState;
    const contextLeft = Math.max(0, 100 - utilizationPercent);

    return html`
      <i class="codicon codicon-window" title="Context window"></i>
      <span
        class="context-state__value"
        title="${formatTokens(inputTokens)} / ${formatTokens(
          contextWindow,
        )} tokens used"
      >
        ${contextLeft.toFixed(0)}% context left
      </span>
    `;
  }

  private buildUsageLabel(): string {
    if (!this.usage) return '';
    const inputTokens = this.usage.inputTokens ?? 0;
    const outputTokens = this.usage.outputTokens ?? 0;
    const cost = this.usage.cost ?? 0;
    return `Total usage: ${formatTokens(inputTokens)} input tokens, ${formatTokens(
      outputTokens,
    )} output tokens, $${cost.toFixed(3)}`;
  }
}
