import { String as Str } from 'effect';
import type { SelectItem } from '@cli/tui/ui/Select';
import type { SurfacedSettingEntry } from '@shared/state/stateSettings';
import { formatResultCount } from '@utils/text/stringUtils';

const CONFIG_CATEGORY_LABELS: Readonly<Record<string, string>> = {
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
};

export function configCategoryLabel(category: string): string {
  return (
    CONFIG_CATEGORY_LABELS[category] ??
    category.split('-').filter(Boolean).map(Str.capitalize).join(' ')
  );
}

export function buildConfigCategoryItems(
  entries: readonly SurfacedSettingEntry[],
): Array<SelectItem<string>> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return Array.from(counts, ([category, count]) => ({
    value: category,
    label: configCategoryLabel(category),
    description: formatResultCount(count, 'setting'),
  }));
}
