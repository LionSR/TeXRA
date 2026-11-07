import { formatResultCount } from '@texra-ai/harness/transcript';
import { Schema } from 'effect';
import type { SelectItem } from '@cli/tui/ui/Select';
import {
  SettingCategorySchema,
  type SettingCategory,
  type TexraSettingRow,
} from '@texra/shared/settingsView/settingSurfaces';

/** Whether a picked value names a settings group, not a linked form. */
export const isSettingCategory = Schema.is(SettingCategorySchema);

const CONFIG_CATEGORY_LABELS: Readonly<Record<SettingCategory, string>> = {
  git: 'Git and worktrees',
  // The `Agents` row above the categories opens the agent library; these two
  // hold what a task's agents may do and the external coding agents' options.
  agents: 'Tasks and agents',
  'ai-agents': 'Codex and Claude Code',
  workflow: 'Workflow run',
  model: 'Models and providers',
  latex: 'LaTeX',
  latexdiff: 'Latexdiff',
  tools: 'Tools',
  privacy: 'Privacy',
};

export function configCategoryLabel(category: SettingCategory): string {
  return CONFIG_CATEGORY_LABELS[category];
}

export function buildConfigCategoryItems(
  entries: readonly TexraSettingRow[],
): Array<SelectItem<string>> {
  const counts = new Map<SettingCategory, number>();
  for (const entry of entries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return Array.from(counts, ([category, count]) => ({
    value: category,
    label: configCategoryLabel(category),
    description: formatResultCount(count, 'setting'),
  }));
}
