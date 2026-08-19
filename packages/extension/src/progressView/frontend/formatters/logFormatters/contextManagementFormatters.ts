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
import type { ActionConfig } from '@progressView/frontend/components/ContextManagement';
import type { ContextManagementRow } from '@shared/transcript';
import type { TeXRAIconName } from '@shared/wa/iconNames';

// Local imports - formatter helpers
import type { FormatResult } from '../baseLogFormatter';

/** Per-action icon and accent color. The label and the stat items are the
 *  row's; only this presentation pair is the webview's. */
const ACTION_PRESENTATION: Record<
  string,
  { icon: TeXRAIconName; color: string }
> = {
  compaction: { icon: 'compress', color: 'var(--wa-color-chart-blue)' },
  clear_tool_uses: { icon: 'trash', color: 'var(--wa-color-chart-green)' },
  clear_thinking: { icon: 'lightbulb', color: 'var(--wa-color-chart-green)' },
  truncation: { icon: 'ellipsis', color: 'var(--wa-color-chart-orange)' },
  max_tokens_reduced: {
    icon: 'caret-down',
    color: 'var(--wa-color-chart-yellow)',
  },
};

/** Icon per context-management item key. */
const ITEM_ICONS: Record<string, TeXRAIconName> = {
  maxTokens: 'arrow-down',
  tokensFreed: 'minus',
  utilization: 'chart-pie',
  contextWindow: 'window-maximize',
  details: 'circle-info',
};

/**
 * Format context management event as TemplateResult. Which events show at all,
 * their label, and their stat items come from the row.
 */
export function formatContextManagementTemplate(
  row: ContextManagementRow,
): FormatResult {
  const presentation = ACTION_PRESENTATION[row.data.action];
  const config: ActionConfig = {
    icon: presentation?.icon ?? 'clock-rotate-left',
    label: row.label,
    color: presentation?.color ?? 'var(--wa-color-text-normal)',
  };
  const items = row.items.map((item) => ({
    icon: ITEM_ICONS[item.key] ?? 'circle-info',
    label: item.label,
    value: item.value,
  }));

  return html`
    <context-management
      .logId=${row.id}
      .config=${config}
      .items=${items}
      .summary=${row.summary?.full ?? ''}
    ></context-management>
  `;
}
