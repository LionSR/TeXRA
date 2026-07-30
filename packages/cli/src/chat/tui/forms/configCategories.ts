import type { SelectItem } from '@cli/tui/ui/Select';
import type { StateSettingEntry } from '@shared/schemas/stateSettings';
import { formatResultCount } from '@utils/text/stringUtils';

const CONFIG_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  git: 'Git and worktrees',
  'ai-agents': 'AI agents',
  workflow: 'Workflow execution',
  model: 'Models and providers',
  latex: 'LaTeX',
  latexdiff: 'Latexdiff',
  tools: 'Tools',
};

export function configCategoryLabel(category: string): string {
  return (
    CONFIG_CATEGORY_LABELS[category] ??
    category
      .split('-')
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
      .join(' ')
  );
}

export function buildConfigCategoryItems(
  entries: readonly StateSettingEntry[],
): Array<SelectItem<string>> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return [...counts].map(([category, count]) => ({
    value: category,
    label: configCategoryLabel(category),
    description: formatResultCount(count, 'setting'),
  }));
}
