/**
 * Context management message formatters.
 * Displays context management events (compaction, clearing, max_tokens reduction)
 * as native UI elements in the progress view.
 *
 * Uses Lit-native component.
 */

// Third-party imports - Lit template utilities
import { html } from 'lit';

// Side-effect import to register the <context-management> custom element
import '@progressView/frontend/components/ContextManagement';

// Local imports - shared schemas and components
import type {
  ActionConfig,
  StatItem,
} from '@progressView/frontend/components/ContextManagement';
import {
  ContextManagementDataSchema,
  type ContextManagementData,
  type LogMessageData,
} from '@shared/schemas';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { formatCompactTokenCount } from '@utils/core';

// Local imports - formatter helpers
import type { FormatResult } from '../baseLogFormatter';

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
  { icon: TeXRAIconName; label: string; color: string }
> = {
  compaction: {
    icon: 'compress',
    label: 'Compacted',
    color: 'var(--wa-color-chart-blue)',
  },
  clear_tool_uses: {
    icon: 'trash',
    label: 'Cleared tool uses',
    color: 'var(--wa-color-chart-green)',
  },
  clear_thinking: {
    icon: 'lightbulb',
    label: 'Cleared thinking',
    color: 'var(--wa-color-chart-green)',
  },
  truncation: {
    icon: 'ellipsis',
    label: 'Truncated',
    color: 'var(--wa-color-chart-orange)',
  },
  max_tokens_reduced: {
    icon: 'caret-down',
    label: 'Max tokens reduced',
    color: 'var(--wa-color-chart-yellow)',
  },
};

/** Build context management items from parsed data. */
function buildContextManagementItems(data: ContextManagementData): {
  config: ActionConfig;
  items: StatItem[];
  summary?: string;
} {
  const { action } = data;

  const config: ActionConfig = ACTION_CONFIG[action] ?? {
    icon: 'clock-rotate-left',
    label: action || 'Context management',
    color: 'var(--wa-color-text-normal)',
  };

  const items: StatItem[] = [];

  // For max_tokens_reduced, show the reduction
  if (action === 'max_tokens_reduced') {
    items.push({
      icon: 'arrow-down',
      label: 'Max tokens reduced',
      value: `${formatCompactTokenCount(data.originalMaxTokens)} → ${formatCompactTokenCount(data.reducedMaxTokens)}`,
    });
  }

  // For clearing actions, show tokens freed.
  // The `action !== 'max_tokens_reduced'` check looks redundant next to
  // `TOKENS_FREED_ACTIONS.has(action)` (which already excludes that action
  // at runtime), but it is what lets TypeScript narrow `data` to the
  // tokens-freed branch of the discriminated union below — dropping it is a
  // compile error (`tokensAfter` doesn't exist on the max_tokens_reduced
  // variant), so keep both checks.
  if (action !== 'max_tokens_reduced' && TOKENS_FREED_ACTIONS.has(action)) {
    const tokensFreed = data.tokensBefore - data.tokensAfter;
    if (tokensFreed > 0) {
      items.push({
        icon: 'minus',
        label: 'Tokens freed',
        value: formatCompactTokenCount(tokensFreed),
      });
    }
  }

  // Show context utilization
  const utilizationBefore = `${data.utilizationBefore.toFixed(1)}%`;
  const utilizationDisplay =
    action !== 'max_tokens_reduced'
      ? `${utilizationBefore} → ${data.utilizationAfter.toFixed(1)}%`
      : utilizationBefore;
  items.push({
    icon: 'chart-pie',
    label: 'Context utilization',
    value: utilizationDisplay,
  });

  items.push({
    icon: 'window-maximize',
    label: 'Context window',
    value: formatCompactTokenCount(data.contextWindow),
  });

  if (data.details) {
    items.push({
      icon: 'circle-info',
      label: 'Details',
      value: data.details,
    });
  }

  return { config, items, summary: data.summary };
}

/** Format context management event as TemplateResult. */
export function formatContextManagementTemplate(
  message: LogMessageData,
): FormatResult {
  const { id, data } = message;

  const parsed = ContextManagementDataSchema.safeParse(data);
  if (!parsed.success) return null;

  // Hide max_tokens_reduced events when the reduced value is still comfortable
  if (
    parsed.data.action === 'max_tokens_reduced' &&
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
