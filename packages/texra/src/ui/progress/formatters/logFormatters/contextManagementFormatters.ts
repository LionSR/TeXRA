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
import '@ui/progress/components/ContextManagement';

// Local imports - shared schemas and components
import type { ActionConfig } from '@ui/progress/components/ContextManagement';
import type { IconName } from '@ui/wa/iconNames';
import type {
  ContextManagementRow,
  StatItem,
} from '@texra-ai/harness/transcript';

// Local imports - formatter helpers
import type { FormatResult } from '../baseLogFormatter';

/** The event's icon and accent color. The label and the stat items are the
 *  row's; only this presentation pair is the webview's. */
const PRESENTATION: { icon: IconName; color: string } = {
  icon: 'caret-down',
  color: 'var(--wa-color-chart-yellow)',
};

/** Icon per context-management item key. */
const ITEM_ICONS: Readonly<Record<StatItem['key'], IconName>> = {
  maxTokens: 'arrow-down',
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
  const config: ActionConfig = { ...PRESENTATION, label: row.label };
  const items = row.items.map((item) => ({
    icon: ITEM_ICONS[item.key],
    label: item.label,
    value: item.value,
  }));

  return html`
    <context-management .config=${config} .items=${items}></context-management>
  `;
}
