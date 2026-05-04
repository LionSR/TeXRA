/**
 * Context management message formatters.
 * Displays context management events (compaction, clearing, max_tokens reduction)
 * as native UI elements in the progress view.
 *
 * Uses Lit-native component.
 */

// Local imports - shared schemas
import type {
  ActionConfig,
  ContextStatItem,
} from '@progressView/frontend/components/ContextManagement';
import {
  ContextManagementDataSchema,
  type ContextManagementData,
  type LogMessageData,
} from '@shared/schemas';

// Local imports - Lit template utilities
import { html, type FormatResult } from '../litTemplates';

// Local imports - formatter helpers
import { formatTokens } from '../timestampUtils';

// Local imports - component types

/**
 * Minimum reduced token threshold below which the "Max Tokens Reduced" event
 * is surfaced in the UI. When the adjusted max_tokens is still at or above
 * this value the reduction is minor and not worth distracting the user with.
 */
const MAX_TOKENS_REDUCED_DISPLAY_THRESHOLD = 32_768;

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
    color: 'var(--texra-charts-blue)',
  },
  clear_tool_uses: {
    icon: 'codicon-trash',
    label: 'Cleared Tool Uses',
    color: 'var(--texra-charts-green)',
  },
  clear_thinking: {
    icon: 'codicon-lightbulb',
    label: 'Cleared Thinking',
    color: 'var(--texra-charts-green)',
  },
  truncation: {
    icon: 'codicon-ellipsis',
    label: 'Truncated',
    color: 'var(--texra-charts-orange)',
  },
  max_tokens_reduced: {
    icon: 'codicon-arrow-small-down',
    label: 'Max Tokens Reduced',
    color: 'var(--texra-charts-yellow)',
  },
};

/** Build context management items from parsed data. */
function buildContextManagementItems(data: ContextManagementData): {
  config: ActionConfig;
  items: ContextStatItem[];
  summary?: string;
} {
  const { action } = data;

  const config: ActionConfig = ACTION_CONFIG[action] || {
    icon: 'codicon-history',
    label: action || 'Context Management',
    color: 'var(--texra-foreground)',
  };

  const items: ContextStatItem[] = [];

  // For max_tokens_reduced, show the reduction
  if (
    action === 'max_tokens_reduced' &&
    data.originalMaxTokens !== undefined &&
    data.reducedMaxTokens !== undefined
  ) {
    items.push({
      icon: 'codicon-arrow-down',
      label: 'Max tokens reduced',
      value: `${formatTokens(data.originalMaxTokens)} → ${formatTokens(data.reducedMaxTokens)}`,
    });
  }

  // For clearing actions, show tokens freed
  if (TOKENS_FREED_ACTIONS.has(action) && data.tokensAfter !== undefined) {
    const tokensFreed = data.tokensBefore - data.tokensAfter;
    if (tokensFreed > 0) {
      items.push({
        icon: 'codicon-dash',
        label: 'Tokens freed',
        value: formatTokens(tokensFreed),
      });
    }
  }

  // Show context utilization
  const utilizationDisplay =
    data.utilizationAfter !== undefined
      ? `${data.utilizationBefore.toFixed(1)}% → ${data.utilizationAfter.toFixed(1)}%`
      : `${data.utilizationBefore.toFixed(1)}%`;
  items.push({
    icon: 'codicon-pie-chart',
    label: 'Context utilization',
    value: utilizationDisplay,
  });

  items.push({
    icon: 'codicon-window',
    label: 'Context window',
    value: formatTokens(data.contextWindow),
  });

  if (data.details) {
    items.push({
      icon: 'codicon-info',
      label: 'Details',
      value: data.details,
    });
  }

  return { config, items, summary: data.summary };
}

/** Format context management event as TemplateResult. */
export function formatContextManagementTemplate(
  message: LogMessageData,
  _options?: { defaultOpen?: boolean },
): FormatResult {
  const { id, data } = message;

  const parsed = ContextManagementDataSchema.safeParse(data);
  if (!parsed.success) return null;

  // Hide max_tokens_reduced events when the reduced value is still comfortable
  if (
    parsed.data.action === 'max_tokens_reduced' &&
    parsed.data.reducedMaxTokens !== undefined &&
    parsed.data.reducedMaxTokens >= MAX_TOKENS_REDUCED_DISPLAY_THRESHOLD
  ) {
    return null;
  }

  const { config, items, summary } = buildContextManagementItems(parsed.data);

  return html`
    <context-management
      .logId=${id}
      .config=${config}
      .items=${items}
      .summary=${summary ?? ''}
    ></context-management>
  `;
}
