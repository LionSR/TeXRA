/**
 * Context management message formatters.
 * Displays context management events (compaction, clearing, max_tokens reduction)
 * as native UI elements in the progress view.
 *
 * Uses Lit-native component.
 */

// Local imports - shared schemas
import {
  ContextManagementDataSchema,
  type LogMessageData,
} from '@shared/schemas';

// Local imports - Lit template utilities
import { html, type FormatResult } from '../litTemplates';

// Local imports - formatter helpers
import { formatTokens } from '../timestampUtils';

// Local imports - component types
import type {
  ActionConfig,
  ContextStatItem,
} from '../../components/ContextManagement';

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

/** Build context management items from data. */
function buildContextManagementItems(
  data: unknown,
): { config: ActionConfig; items: ContextStatItem[]; summary?: string } | null {
  const result = ContextManagementDataSchema.safeParse(data);
  if (!result.success) {
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
    summary,
    compactionModel,
  } = result.data;

  const config: ActionConfig = ACTION_CONFIG[action] || {
    icon: 'codicon-history',
    label: action || 'Context Management',
    color: 'var(--vscode-foreground)',
  };

  // Build stat items
  const items: ContextStatItem[] = [];

  // For max_tokens_reduced, show the reduction
  if (
    action === 'max_tokens_reduced' &&
    originalMaxTokens !== undefined &&
    reducedMaxTokens !== undefined
  ) {
    items.push({
      icon: 'codicon-arrow-down',
      label: 'Max tokens reduced',
      value: `${formatTokens(originalMaxTokens)} → ${formatTokens(reducedMaxTokens)}`,
    });
  }

  // For clearing actions, show tokens freed
  if (TOKENS_FREED_ACTIONS.has(action) && tokensAfter !== undefined) {
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
  const utilizationDisplay =
    utilizationAfter !== undefined
      ? `${utilizationBefore.toFixed(1)}% → ${utilizationAfter.toFixed(1)}%`
      : `${utilizationBefore.toFixed(1)}%`;
  items.push({
    icon: 'codicon-pie-chart',
    label: 'Context utilization',
    value: utilizationDisplay,
  });

  // Show context window
  items.push({
    icon: 'codicon-window',
    label: 'Context window',
    value: formatTokens(contextWindow),
  });

  // Show details if present
  if (details) {
    items.push({
      icon: 'codicon-info',
      label: 'Details',
      value: details,
    });
  }

  if (compactionModel) {
    items.push({
      icon: 'codicon-tag',
      label: 'Compaction model',
      value: compactionModel,
    });
  }

  return { config, items, summary };
}

/** Format context management event as TemplateResult. */
export function formatContextManagementTemplate(
  message: LogMessageData,
  _options?: { defaultOpen?: boolean },
): FormatResult {
  const { id, data } = message;
  const result = buildContextManagementItems(data);
  if (!result) return null;

  const { config, items } = result;

  return html`
    <context-management
      .logId=${id}
      .config=${config}
      .items=${items}
      .summary=${result.summary}
    ></context-management>
  `;
}
