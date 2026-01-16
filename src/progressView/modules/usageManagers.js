// Local imports - progress view
import { ELEMENT_IDS } from './constants.js';
import { formatTokens } from './formatters/index.js';
// Local imports
import { progressViewState } from './progressViewState.js';

/**
 * Build HTML and aria-label segments for cache token display.
 * @param {number} tokens - Token count
 * @param {string} iconClass - Codicon class name (without 'codicon-' prefix)
 * @param {string} titleText - Title for HTML tooltip
 * @param {string} ariaText - Text for aria-label
 * @returns {{ html: string, aria: string }}
 */
function buildCacheSegment(tokens, iconClass, titleText, ariaText) {
  if (tokens <= 0) {
    return { html: '', aria: '' };
  }
  const formatted = formatTokens(tokens);
  return {
    html: ` · <i class="codicon codicon-${iconClass}" title="${titleText}"></i>${formatted}`,
    aria: `, ${formatted} ${ariaText}`,
  };
}

/**
 * Manages usage summary display.
 */
export class UsageSummary {
  constructor() {
    this._summaryElem = null;
    this._contextElem = null;
    this._footerElem = null;
  }

  /** Get cached element or fetch by ID, validating connection */
  _getCachedElement(cacheKey, elementId) {
    if (this[cacheKey]?.isConnected) return this[cacheKey];
    this[cacheKey] = document.getElementById(elementId);
    return this[cacheKey];
  }

  /** Get the summary element with caching */
  _getSummary() {
    return this._getCachedElement('_summaryElem', ELEMENT_IDS.RUN_SUMMARY);
  }

  /** Get the context element with caching */
  _getContext() {
    return this._getCachedElement('_contextElem', ELEMENT_IDS.CONTEXT_STATE);
  }

  /** Get the footer element, deriving from anchor elements */
  _getFooter() {
    if (this._footerElem?.isConnected) return this._footerElem;
    const anchor = this._summaryElem || this._contextElem;
    if (anchor) {
      this._footerElem = anchor.closest('.usage-summary-footer');
    }
    return this._footerElem;
  }

  /** Sync footer visibility based on whether context is displayed */
  _syncFooterVisibility(footer) {
    if (!footer) return;
    const contextElem = this._getContext();
    footer.hidden = contextElem?.hidden !== false;
  }

  /**
   * Update token and cost summary in the footer by aggregating usage from
   * "Round" groups. Falls back to the provided usage if given.
   * @param {Object} [usage] - Optional pre-computed usage totals
   */
  update(usage) {
    const summaryElem = this._getSummary();
    if (!summaryElem) return;

    const footer = this._getFooter();
    // If usage is not provided, compute it from existing log groups
    const totals = usage ?? this.computeTotal();

    const inputTokens = totals?.inputTokens ?? 0;
    const outputTokens = totals?.outputTokens ?? 0;
    const cost = totals?.cost ?? 0;
    const cacheReadTokens = totals?.cacheReadInputTokens ?? 0;
    const cacheCreationTokens = totals?.cacheCreationInputTokens ?? 0;

    if (!inputTokens && !outputTokens && !cost) {
      summaryElem.textContent = '';
      summaryElem.removeAttribute('aria-label');
      this._syncFooterVisibility(footer);
      return;
    }

    if (footer) footer.hidden = false;

    const formattedInput = formatTokens(inputTokens);
    const formattedOutput = formatTokens(outputTokens);
    const formattedCost = `$${cost.toFixed(3)}`;

    // Build cache segments: placed after input since cache is conceptually related to input
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

    summaryElem.innerHTML = `
      <i class="codicon codicon-meter"></i>
      <span class="run-summary__label">Total usage:</span>
      <span class="run-summary__value">
        <i class="codicon codicon-arrow-up" title="Input tokens"></i>${formattedInput}${cacheRead.html}${cacheCreation.html} ·
        <i class="codicon codicon-arrow-down" title="Output tokens"></i>${formattedOutput} ·
        ${formattedCost}
      </span>
    `;
    summaryElem.setAttribute(
      'aria-label',
      `Total usage: ${formattedInput} input tokens${cacheRead.aria}${cacheCreation.aria}, ${formattedOutput} output tokens, ${formattedCost}`,
    );
  }

  /**
   * Compute total usage for the active session in the active stream.
   * Each stream tab can have multiple sessions; this returns the current session's total.
   * @returns {Object} Total usage with inputTokens, outputTokens, cost, and cache token counts
   */
  computeTotal() {
    const emptyUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const stream = progressViewState.activeStream;
    const activeRunId = stream && progressViewState.resolveActiveRunId(stream);
    if (!activeRunId) {
      return emptyUsage;
    }
    const usage = progressViewState.getRunUsage(stream, activeRunId);
    return usage ? { ...emptyUsage, ...usage } : emptyUsage;
  }

  /**
   * Update the context utilization display in the footer.
   * Shows "X% context left" based on current input tokens vs context window.
   * @param {{ inputTokens: number, contextWindow: number, utilizationPercent: number }} contextState
   */
  updateContextDisplay(contextState) {
    const contextElem = this._getContext();
    if (!contextElem) return;

    const { inputTokens, contextWindow, utilizationPercent } = contextState;

    if (!contextWindow || contextWindow <= 0) {
      contextElem.textContent = '';
      contextElem.hidden = true;
      return;
    }

    // Ensure footer is visible when context state is displayed
    const footer = this._getFooter();
    if (footer) footer.hidden = false;

    const contextLeft = Math.max(0, 100 - utilizationPercent);
    const formattedInput = formatTokens(inputTokens);
    const formattedWindow = formatTokens(contextWindow);

    contextElem.innerHTML = `
      <i class="codicon codicon-window" title="Context window"></i>
      <span class="context-state__value" title="${formattedInput} / ${formattedWindow} tokens used">
        ${contextLeft.toFixed(0)}% context left
      </span>
    `;
    contextElem.hidden = false;
  }

  /**
   * Clear the context state display.
   * Also hides the footer if usage summary is empty.
   */
  clearContextDisplay() {
    const contextElem = this._getContext();
    if (!contextElem) return;

    contextElem.textContent = '';
    contextElem.hidden = true;

    // Hide footer if usage is also empty
    const summaryElem = this._getSummary();
    if (!summaryElem?.textContent) {
      const footer = this._getFooter();
      if (footer) footer.hidden = true;
    }
  }
}
