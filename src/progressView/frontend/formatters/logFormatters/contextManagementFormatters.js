/**
 * Context management message formatters.
 * Displays context management events (compaction, clearing, max_tokens reduction)
 * as native UI elements in the progress view.
 */

import { createFromTemplate } from '../templateUtils.ts';
import { initToggleIcon } from '../htmlBuilders.js';
import { formatTokens } from '../timestampUtils.js';

// Actions that show tokens freed stat
const TOKENS_FREED_ACTIONS = new Set([
  'clear_tool_uses',
  'clear_thinking',
  'compaction',
]);

/**
 * Action display configuration
 * @type {Record<string, {icon: string, label: string, color: string}>}
 */
const ACTION_CONFIG = {
  compaction: {
    icon: 'codicon-fold',
    label: 'Compacted',
    color: 'var(--vscode-charts-blue)',
  },
  clear_tool_uses: {
    icon: 'codicon-trash',
    label: 'Cleared Tool Uses',
    color: 'var(--vscode-charts-green)',
  },
  clear_thinking: {
    icon: 'codicon-lightbulb',
    label: 'Cleared Thinking',
    color: 'var(--vscode-charts-green)',
  },
  truncation: {
    icon: 'codicon-ellipsis',
    label: 'Truncated',
    color: 'var(--vscode-charts-orange)',
  },
  max_tokens_reduced: {
    icon: 'codicon-arrow-small-down',
    label: 'Max Tokens Reduced',
    color: 'var(--vscode-charts-yellow)',
  },
};

/**
 * Format context management event for display
 * @param {object} normalizedPayload - Normalized payload with structured data
 * @param {string} logId - Log entry ID
 * @returns {HTMLElement|null} Context management element or null
 */
export const formatContextManagement = (normalizedPayload, logId) => {
  const parsed = normalizedPayload?.structured;
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const element = createFromTemplate('contextManagementTemplate');
  if (!element) return null;

  const contentElem = element.querySelector('.context-management-content');
  initToggleIcon(element, false);

  const {
    action,
    tokensBefore,
    tokensAfter,
    contextWindow,
    utilizationBefore,
    utilizationAfter,
    originalMaxTokens,
    reducedMaxTokens,
    details,
  } = parsed;

  const config = ACTION_CONFIG[action] || {
    icon: 'codicon-history',
    label: action || 'Context Management',
    color: 'var(--vscode-foreground)',
  };

  // Update the icon and title
  const iconElem = element.querySelector('.context-management-icon');
  if (iconElem) {
    iconElem.className = `codicon ${config.icon} context-management-icon`;
    iconElem.style.color = config.color;
  }

  const titleElem = element.querySelector('.context-management-title');
  if (titleElem) {
    titleElem.textContent = config.label;
    titleElem.style.color = config.color;
  }

  // Build stat items
  const items = [];
  const pushItem = (icon, label, value, suffix = '') => {
    items.push(
      `<span class="stat-item detail-item" title="${label}"><i class="codicon ${icon}"></i> ${value}${suffix}</span>`,
    );
  };

  // For max_tokens_reduced, show the reduction
  if (
    action === 'max_tokens_reduced' &&
    originalMaxTokens &&
    reducedMaxTokens
  ) {
    pushItem(
      'codicon-arrow-down',
      'Max tokens reduced',
      `${formatTokens(originalMaxTokens)} → ${formatTokens(reducedMaxTokens)}`,
    );
  }

  // For clearing actions, show tokens freed
  if (
    TOKENS_FREED_ACTIONS.has(action) &&
    tokensBefore !== undefined &&
    tokensAfter !== undefined
  ) {
    const tokensFreed = tokensBefore - tokensAfter;
    if (tokensFreed > 0) {
      pushItem('codicon-dash', 'Tokens freed', formatTokens(tokensFreed));
    }
  }

  // Show context utilization
  if (utilizationBefore !== undefined) {
    const utilizationDisplay =
      utilizationAfter !== undefined
        ? `${utilizationBefore.toFixed(1)}% → ${utilizationAfter.toFixed(1)}%`
        : `${utilizationBefore.toFixed(1)}%`;
    pushItem('codicon-pie-chart', 'Context utilization', utilizationDisplay);
  }

  // Show context window
  if (contextWindow !== undefined) {
    pushItem('codicon-window', 'Context window', formatTokens(contextWindow));
  }

  // Show details if present
  if (details) {
    pushItem('codicon-info', 'Details', details);
  }

  if (contentElem) {
    contentElem.innerHTML = items.join('');
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
};
