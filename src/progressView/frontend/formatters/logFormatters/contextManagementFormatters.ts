/**
 * Context management message formatters.
 * Displays context management events (compaction, clearing, max_tokens reduction)
 * as native UI elements in the progress view.
 */

// Local imports - common helpers
import { createFromTemplate } from '@common/modules/templateUtils.js';

// Local imports - formatter helpers
import { initToggleIcon } from '../htmlBuilders';
import { formatTokens } from '../timestampUtils';
import type { NormalizedPayload } from '../normalizers';

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
const ACTION_CONFIG: Record<
  string,
  { icon: string; label: string; color: string }
> = {
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
export const formatContextManagement = (
  normalizedPayload: NormalizedPayload,
  logId: string,
): HTMLElement | null => {
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
  } = parsed as Record<string, unknown>;

  const actionValue = typeof action === 'string' ? action : '';
  const config = ACTION_CONFIG[actionValue] || {
    icon: 'codicon-history',
    label: actionValue || 'Context Management',
    color: 'var(--vscode-foreground)',
  };

  // Update the icon and title
  const iconElem = element.querySelector('.context-management-icon');
  if (iconElem instanceof HTMLElement) {
    iconElem.className = `codicon ${config.icon} context-management-icon`;
    iconElem.style.color = config.color;
  }

  const titleElem = element.querySelector('.context-management-title');
  if (titleElem instanceof HTMLElement) {
    titleElem.textContent = config.label;
    titleElem.style.color = config.color;
  }

  // Build stat items
  const items: string[] = [];
  const pushItem = (
    icon: string,
    label: string,
    value: string,
    suffix = '',
  ) => {
    items.push(
      `<span class="stat-item detail-item" title="${label}"><i class="codicon ${icon}"></i> ${value}${suffix}</span>`,
    );
  };

  // For max_tokens_reduced, show the reduction
  if (
    actionValue === 'max_tokens_reduced' &&
    typeof originalMaxTokens === 'number' &&
    typeof reducedMaxTokens === 'number'
  ) {
    pushItem(
      'codicon-arrow-down',
      'Max tokens reduced',
      `${formatTokens(originalMaxTokens)} → ${formatTokens(reducedMaxTokens)}`,
    );
  }

  // For clearing actions, show tokens freed
  if (
    TOKENS_FREED_ACTIONS.has(actionValue) &&
    typeof tokensBefore === 'number' &&
    typeof tokensAfter === 'number'
  ) {
    const tokensFreed = tokensBefore - tokensAfter;
    if (tokensFreed > 0) {
      pushItem('codicon-dash', 'Tokens freed', formatTokens(tokensFreed));
    }
  }

  // Show context utilization
  if (typeof utilizationBefore === 'number') {
    const utilizationDisplay =
      typeof utilizationAfter === 'number'
        ? `${utilizationBefore.toFixed(1)}% → ${utilizationAfter.toFixed(1)}%`
        : `${utilizationBefore.toFixed(1)}%`;
    pushItem('codicon-pie-chart', 'Context utilization', utilizationDisplay);
  }

  // Show context window
  if (typeof contextWindow === 'number') {
    pushItem('codicon-window', 'Context window', formatTokens(contextWindow));
  }

  // Show details if present
  if (typeof details === 'string' && details) {
    pushItem('codicon-info', 'Details', details);
  }

  if (contentElem instanceof HTMLElement) {
    contentElem.innerHTML = items.join('');
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
};
