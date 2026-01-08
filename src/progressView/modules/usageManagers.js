// Local imports - progress view
import { ELEMENT_IDS } from './constants.js';
import { formatTokens } from './formatters/index.js';
// Local imports
import { progressViewState } from './progressViewState.js';

/**
 * Manages usage summary display.
 */
export class UsageSummary {
  constructor() {
    this._summaryElem = null;
    this._contextElem = null;
  }

  /**
   * Update token and cost summary in the footer by aggregating usage from
   * "Round" groups. Falls back to the provided usage if given.
   * @param {Object} [usage] - Optional pre-computed usage totals
   */
  update(usage) {
    // Cache the summary element
    if (!this._summaryElem) {
      this._summaryElem = document.getElementById(ELEMENT_IDS.RUN_SUMMARY);
    }
    if (!this._summaryElem) return;
    const footer = this._summaryElem.closest('.usage-summary-footer');
    // If usage is not provided, compute it from existing log groups
    const totals = usage ?? this.computeTotal();

    const inputTokens = totals?.inputTokens ?? 0;
    const outputTokens = totals?.outputTokens ?? 0;
    const cost = totals?.cost ?? 0;
    const cacheCreationTokens = totals?.cacheCreationInputTokens ?? 0;

    if (!inputTokens && !outputTokens && !cost) {
      this._summaryElem.textContent = '';
      this._summaryElem.removeAttribute('aria-label');
      if (footer) {
        footer.hidden = true;
      }
      return;
    }

    if (footer) {
      footer.hidden = false;
    }

    const formattedInput = formatTokens(inputTokens);
    const formattedOutput = formatTokens(outputTokens);
    const formattedCost = `$${cost.toFixed(3)}`;

    // Build cache creation segment if present (Anthropic: charged at 1.25x input price)
    const cacheCreationSegment = cacheCreationTokens > 0
      ? ` · <i class="codicon codicon-database" title="Cache creation tokens (1.25x cost)"></i>${formatTokens(cacheCreationTokens)}`
      : '';
    const cacheCreationAriaLabel = cacheCreationTokens > 0
      ? `, ${formatTokens(cacheCreationTokens)} cache creation tokens`
      : '';

    this._summaryElem.innerHTML = `
      <i class="codicon codicon-meter"></i>
      <span class="run-summary__label">Total usage:</span>
      <span class="run-summary__value">
        <i class="codicon codicon-arrow-up" title="Input tokens"></i>${formattedInput} ·
        <i class="codicon codicon-arrow-down" title="Output tokens"></i>${formattedOutput}${cacheCreationSegment} ·
        ${formattedCost}
      </span>
    `;
    this._summaryElem.setAttribute(
      'aria-label',
      `Total usage: ${formattedInput} input tokens, ${formattedOutput} output tokens${cacheCreationAriaLabel}, ${formattedCost}`,
    );
  }

  /**
   * Compute total usage for the active session in the active stream.
   * Each stream tab can have multiple sessions; this returns the current session's total.
   * @returns {Object} Total usage with inputTokens, outputTokens, cost, and cacheCreationInputTokens
   */
  computeTotal() {
    const stream = progressViewState.activeStream;
    const activeRunId = progressViewState.resolveActiveRunId(stream);
    if (stream && activeRunId) {
      const usage = progressViewState.getRunUsage(stream, activeRunId);
      if (usage) {
        return {
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
          cost: usage.cost || 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens || 0,
        };
      }
    }

    return { inputTokens: 0, outputTokens: 0, cost: 0, cacheCreationInputTokens: 0 };
  }

  /**
   * Update the context utilization display in the footer.
   * Shows "X% context left" based on current input tokens vs context window.
   * @param {{ inputTokens: number, contextWindow: number, utilizationPercent: number }} contextState
   */
  updateContextDisplay(contextState) {
    // Cache the context element
    if (!this._contextElem) {
      this._contextElem = document.getElementById('contextState');
    }
    if (!this._contextElem) return;

    const { inputTokens, contextWindow, utilizationPercent } = contextState;

    if (!contextWindow || contextWindow <= 0) {
      this._contextElem.textContent = '';
      this._contextElem.hidden = true;
      return;
    }

    const contextLeft = Math.max(0, 100 - utilizationPercent);
    const formattedInput = formatTokens(inputTokens);
    const formattedWindow = formatTokens(contextWindow);

    this._contextElem.innerHTML = `
      <i class="codicon codicon-window" title="Context window"></i>
      <span class="context-state__value" title="${formattedInput} / ${formattedWindow} tokens used">
        ${contextLeft.toFixed(0)}% context left
      </span>
    `;
    this._contextElem.hidden = false;
  }

  /**
   * Clear the context state display.
   */
  clearContextDisplay() {
    if (!this._contextElem) {
      this._contextElem = document.getElementById('contextState');
    }
    if (this._contextElem) {
      this._contextElem.textContent = '';
      this._contextElem.hidden = true;
    }
  }
}
