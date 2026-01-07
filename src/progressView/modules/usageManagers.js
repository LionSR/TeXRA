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

    this._summaryElem.innerHTML = `
      <i class="codicon codicon-meter"></i>
      <span class="run-summary__label">Total usage:</span>
      <span class="run-summary__value">
        <i class="codicon codicon-arrow-up" title="Input tokens"></i>${formattedInput} ·
        <i class="codicon codicon-arrow-down" title="Output tokens"></i>${formattedOutput} ·
        ${formattedCost}
      </span>
    `;
    this._summaryElem.setAttribute(
      'aria-label',
      `Total usage: ${formattedInput} input tokens, ${formattedOutput} output tokens, ${formattedCost}`,
    );
  }

  /**
   * Compute total usage for the active session in the active stream.
   * Sums usage across all runs (rounds) in the stream.
   * @returns {Object} Total usage with inputTokens, outputTokens, and cost
   */
  computeTotal() {
    const stream = progressViewState.activeStream;
    if (!stream) {
      return { inputTokens: 0, outputTokens: 0, cost: 0 };
    }

    const usageMap = progressViewState.runUsage.getStreamMap(stream);
    if (!usageMap || usageMap.size === 0) {
      return { inputTokens: 0, outputTokens: 0, cost: 0 };
    }

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (const usage of usageMap.values()) {
      if (usage) {
        totalInput += usage.inputTokens ?? 0;
        totalOutput += usage.outputTokens ?? 0;
        totalCost += usage.cost ?? 0;
      }
    }

    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cost: totalCost,
    };
  }
}
