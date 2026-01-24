// Third-party imports
import { LitElement, html } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { customElement, property } from 'lit/decorators.js';

// Local imports - formatters
import { formatTokens } from '../formatters/timestampUtils.js';

// Local types
import type { TokenUsageStats } from '@shared/schemas';
import type { ContextState } from '../store';

function buildCacheSegment(
  tokens: number,
  iconClass: string,
  titleText: string,
  ariaText: string,
) {
  if (tokens <= 0) {
    return { html: '', aria: '' };
  }
  const formatted = formatTokens(tokens);
  return {
    html: ` · <i class="codicon codicon-${iconClass}" title="${titleText}"></i>${formatted}`,
    aria: `, ${formatted} ${ariaText}`,
  };
}

@customElement('usage-panel')
export class UsagePanel extends LitElement {
  @property({ type: Object }) usage: TokenUsageStats | null = null;
  @property({ type: Object }) contextState: ContextState | null = null;
  @property({ type: Boolean }) visible = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  private renderSummary() {
    if (!this.usage) return null;

    const inputTokens = this.usage.inputTokens ?? 0;
    const outputTokens = this.usage.outputTokens ?? 0;
    const cost = this.usage.cost ?? 0;
    const cacheReadTokens = this.usage.cacheReadInputTokens ?? 0;
    const cacheCreationTokens = this.usage.cacheCreationInputTokens ?? 0;

    if (!inputTokens && !outputTokens && !cost) return null;

    const formattedInput = formatTokens(inputTokens);
    const formattedOutput = formatTokens(outputTokens);
    const formattedCost = `$${cost.toFixed(3)}`;

    const cacheRead = buildCacheSegment(
      cacheReadTokens,
      'cloud-download',
      'Cache read tokens (discounted)',
      'cache read tokens',
    );
    const cacheCreation = buildCacheSegment(
      cacheCreationTokens,
      'database',
      'Cache creation tokens (1.25x cost)',
      'cache creation tokens',
    );

    return html`
      <div class="run-summary" id="runSummary">
        <i class="codicon codicon-meter"></i>
        <span class="run-summary__label">Total usage:</span>
        <span
          class="run-summary__value"
          aria-label=${`Total usage: ${formattedInput} input tokens${cacheRead.aria}${cacheCreation.aria}, ${formattedOutput} output tokens, ${formattedCost}`}
        >
          <i class="codicon codicon-arrow-up" title="Input tokens"></i>
          ${formattedInput}
          ${unsafeHTML(`${cacheRead.html}${cacheCreation.html}`)} ·
          <i class="codicon codicon-arrow-down" title="Output tokens"></i>
          ${formattedOutput} · ${formattedCost}
        </span>
      </div>
    `;
  }

  private renderContext() {
    if (!this.contextState) return null;

    const { inputTokens, contextWindow, utilizationPercent } =
      this.contextState;
    if (!contextWindow || contextWindow <= 0) return null;

    const contextLeft = Math.max(0, 100 - utilizationPercent);
    const formattedInput = formatTokens(inputTokens);
    const formattedWindow = formatTokens(contextWindow);

    return html`
      <div class="context-state" id="contextState">
        <i class="codicon codicon-window" title="Context window"></i>
        <span
          class="context-state__value"
          title=${`${formattedInput} / ${formattedWindow} tokens used`}
        >
          ${contextLeft.toFixed(0)}% context left
        </span>
      </div>
    `;
  }

  override render() {
    if (!this.visible) return null;

    const summary = this.renderSummary();
    const context = this.renderContext();

    if (!summary && !context) return null;

    return html`
      <div class="usage-summary-footer">${context} ${summary}</div>
    `;
  }
}
