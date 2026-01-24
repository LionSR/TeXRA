// Local imports
import { buildBannerEntry } from '../baseLogFormatter';
import { formatTokens } from '../timestampUtils';
import { encodeHtml } from '../htmlEncoding';

const TOKENS_FREED_ACTIONS = new Set([
  'clear_tool_uses',
  'clear_thinking',
  'compaction',
]);

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

export const formatContextManagement = (
  normalizedPayload: { structured?: Record<string, any> },
  logId: string,
): string | null => {
  const parsed = normalizedPayload?.structured;
  if (!parsed || typeof parsed !== 'object') {
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
  } = parsed;

  const config = ACTION_CONFIG[action] || {
    icon: 'codicon-history',
    label: action || 'Context Management',
    color: 'var(--vscode-foreground)',
  };

  const items: string[] = [];
  const pushItem = (icon: string, label: string, value: string) => {
    items.push(
      `<span class="stat-item detail-item" title="${encodeHtml(
        label,
      )}"><i class="codicon ${icon}"></i> ${encodeHtml(value)}</span>`,
    );
  };

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

  if (utilizationBefore !== undefined) {
    const utilizationDisplay =
      utilizationAfter !== undefined
        ? `${utilizationBefore.toFixed(1)}% → ${utilizationAfter.toFixed(1)}%`
        : `${utilizationBefore.toFixed(1)}%`;
    pushItem('codicon-pie-chart', 'Context utilization', utilizationDisplay);
  }

  if (contextWindow !== undefined) {
    pushItem('codicon-window', 'Context window', formatTokens(contextWindow));
  }

  if (details) {
    pushItem('codicon-info', 'Details', String(details));
  }

  return buildBannerEntry({
    logId,
    iconClass: config.icon,
    labelHtml: `<span style="color: ${config.color}">${encodeHtml(
      config.label,
    )}</span>`,
    contentClass: 'context-management-content',
    extraClasses: ['context-management-details'],
    contentHtml: `<div class="context-management-content">${items.join('')}</div>`,
    rawContent: items.join(' '),
  });
};
