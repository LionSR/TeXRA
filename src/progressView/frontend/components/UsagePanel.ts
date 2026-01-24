// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports
import type { TokenUsageStats } from '@shared/schemas';
import type { ContextState } from '../store';
import { formatTokens } from '../formatters';

@customElement('usage-panel')
export class UsagePanel extends LitElement {
  @property({ type: Object }) usage: TokenUsageStats | null = null;
  @property({ type: Object }) contextState: ContextState | null = null;

  createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult | null {
    if (!this.usage && !this.contextState) return null;

    return html`
      <div class="usage-summary-footer">
        ${this.renderContext()} ${this.renderUsage()}
      </div>
    `;
  }

  private renderUsage(): TemplateResult | null {
    if (!this.usage) return null;

    const inputTokens = this.usage.inputTokens ?? 0;
    const outputTokens = this.usage.outputTokens ?? 0;
    const cost = this.usage.cost ?? 0;
    const cacheRead = this.usage.cacheReadInputTokens ?? 0;
    const cacheCreation = this.usage.cacheCreationInputTokens ?? 0;

    const cacheReadSegment =
      cacheRead > 0
        ? html` ·
            <i
              class="codicon codicon-cloud-download"
              title="Cache read tokens (discounted)"
            ></i
            >${formatTokens(cacheRead)}`
        : null;
    const cacheCreationSegment =
      cacheCreation > 0
        ? html` ·
            <i
              class="codicon codicon-database"
              title="Cache creation tokens (1.25x cost)"
            ></i
            >${formatTokens(cacheCreation)}`
        : null;

    return html`
      <span class="run-summary" id="runSummary">
        <i class="codicon codicon-meter"></i>
        <span class="run-summary__label">Total usage:</span>
        <span class="run-summary__value">
          <i class="codicon codicon-arrow-up" title="Input tokens"></i
          >${formatTokens(
            inputTokens,
          )}${cacheReadSegment}${cacheCreationSegment}
          ·
          <i class="codicon codicon-arrow-down" title="Output tokens"></i
          >${formatTokens(outputTokens)} · $${cost.toFixed(3)}
        </span>
      </span>
    `;
  }

  private renderContext(): TemplateResult | null {
    if (!this.contextState?.contextWindow) return null;

    const contextLeft = Math.max(0, 100 - this.contextState.utilizationPercent);
    const formattedInput = formatTokens(this.contextState.inputTokens);
    const formattedWindow = formatTokens(this.contextState.contextWindow);

    return html`
      <span class="context-state" id="contextState">
        <i class="codicon codicon-window" title="Context window"></i>
        <span
          class="context-state__value"
          title="${formattedInput} / ${formattedWindow} tokens used"
        >
          ${contextLeft.toFixed(0)}% context left
        </span>
      </span>
    `;
  }
}
