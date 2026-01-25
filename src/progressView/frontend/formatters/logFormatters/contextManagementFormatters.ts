/**
 * Context management message formatters.
 * Displays context management events (compaction, clearing, max_tokens reduction)
 * as native UI elements in the progress view.
 *
 * Uses Lit templates for declarative DOM construction.
 */

// Local imports - Lit template utilities
import { html, ifDefined, renderToElement } from '../litTemplates';

// Local imports - formatter helpers
import { formatTokens } from '../timestampUtils';

// Actions that show tokens freed stat
const TOKENS_FREED_ACTIONS = new Set([
  'clear_tool_uses',
  'clear_thinking',
  'compaction',
]);

/** Action display configuration. */
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

type StatItem = { icon: string; label: string; value: string };

/** Format context management event for display. */
export function formatContextManagement(
  data: unknown,
  logId: string,
): HTMLElement | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

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
  } = data as Record<string, unknown>;

  const actionValue = typeof action === 'string' ? action : '';
  const config = ACTION_CONFIG[actionValue] || {
    icon: 'codicon-history',
    label: actionValue || 'Context Management',
    color: 'var(--vscode-foreground)',
  };

  // Build stat items
  const items: StatItem[] = [];

  // For max_tokens_reduced, show the reduction
  if (
    actionValue === 'max_tokens_reduced' &&
    typeof originalMaxTokens === 'number' &&
    typeof reducedMaxTokens === 'number'
  ) {
    items.push({
      icon: 'codicon-arrow-down',
      label: 'Max tokens reduced',
      value: `${formatTokens(originalMaxTokens)} → ${formatTokens(reducedMaxTokens)}`,
    });
  }

  // For clearing actions, show tokens freed
  if (
    TOKENS_FREED_ACTIONS.has(actionValue) &&
    typeof tokensBefore === 'number' &&
    typeof tokensAfter === 'number'
  ) {
    const tokensFreed = tokensBefore - tokensAfter;
    if (tokensFreed > 0) {
      items.push({
        icon: 'codicon-dash',
        label: 'Tokens freed',
        value: formatTokens(tokensFreed),
      });
    }
  }

  // Show context utilization
  if (typeof utilizationBefore === 'number') {
    const utilizationDisplay =
      typeof utilizationAfter === 'number'
        ? `${utilizationBefore.toFixed(1)}% → ${utilizationAfter.toFixed(1)}%`
        : `${utilizationBefore.toFixed(1)}%`;
    items.push({
      icon: 'codicon-pie-chart',
      label: 'Context utilization',
      value: utilizationDisplay,
    });
  }

  // Show context window
  if (typeof contextWindow === 'number') {
    items.push({
      icon: 'codicon-window',
      label: 'Context window',
      value: formatTokens(contextWindow),
    });
  }

  // Show details if present
  if (typeof details === 'string' && details) {
    items.push({
      icon: 'codicon-info',
      label: 'Details',
      value: details,
    });
  }

  return renderToElement(html`
    <details class="banner-details context-management-details">
      <summary class="details-summary">
        <i class="toggle-icon"></i>
        <i
          class=${`codicon ${config.icon} context-management-icon`}
          style=${`color: ${config.color}`}
        ></i>
        <span class="context-management-title" style=${`color: ${config.color}`}
          >${config.label}</span
        >
      </summary>
      <div class="context-management-content" data-log-id=${ifDefined(logId)}>
        ${items.map(
          (item) => html`
            <span class="stat-item detail-item" title=${item.label}>
              <i class=${`codicon ${item.icon}`}></i> ${item.value}
            </span>
          `,
        )}
      </div>
    </details>
  `);
}
