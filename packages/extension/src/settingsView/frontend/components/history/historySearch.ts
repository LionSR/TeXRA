import type { HistoryItem } from '@shared/schemas';
import { getAgentCategoryDecorator } from '@shared/utils/icons';

type ToolConfigEntry = [string, unknown];

function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

function hasSearchValue(value: unknown): boolean {
  if (value == null) return false;
  return !Array.isArray(value) || value.length > 0;
}

function addSearchValue(parts: string[], value: unknown): void {
  if (value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      addSearchValue(parts, item);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      parts.push(key);
      addSearchValue(parts, nested);
    }
    return;
  }

  if (typeof value === 'boolean') {
    parts.push(value ? 'Yes' : 'No');
    return;
  }

  parts.push(String(value));
}

function addLabelledValue(
  parts: string[],
  label: string,
  value: unknown,
): boolean {
  if (!hasSearchValue(value)) return false;

  parts.push(label);
  addSearchValue(parts, value);
  return true;
}

function addConfigSection(
  parts: string[],
  sectionLabel: string,
  entries: ToolConfigEntry[],
): boolean {
  const visibleEntries = entries.filter(([, value]) => hasSearchValue(value));
  if (visibleEntries.length === 0) return false;

  parts.push(sectionLabel);
  for (const [key, value] of visibleEntries) {
    parts.push(key);
    addSearchValue(parts, value);
  }
  return true;
}

/**
 * Build a lowercase search body matching the fields HistoryItemElement renders.
 */
export function getHistorySearchText(item: HistoryItem): string {
  const parts: string[] = [
    item.id,
    item.timestamp,
    new Date(item.timestamp).toLocaleString(),
  ];
  addSearchValue(parts, item.description);

  const config = item.agentConfig;
  parts.push('Category', getAgentCategoryDecorator(config.agentCategory).label);
  parts.push('Agent');
  addSearchValue(parts, config.agent ?? 'Unknown');
  parts.push('Model');
  addSearchValue(parts, config.model ?? 'Unknown');
  parts.push('Instruction');
  addSearchValue(
    parts,
    config.instruction?.trim() ? config.instruction : 'Not set',
  );

  if (config.agentCategory === 'workflow') {
    addLabelledValue(parts, 'InputFiles', config.inputFiles);
    addLabelledValue(parts, 'MediaFiles', config.mediaFiles);

    const hasMoreDetails = [
      addConfigSection(parts, 'Context', [
        ['ContextFiles', config.contextFiles],
      ]),
      addConfigSection(parts, 'Output Files', [['Files', config.outputFiles]]),
      config.toolConfig
        ? addConfigSection(parts, 'Config', Object.entries(config.toolConfig))
        : false,
    ].some(Boolean);

    if (hasMoreDetails) {
      parts.push('More details');
    }
  }

  return normalizeSearchText(parts.join('\n'));
}

export function getHistorySearchTokens(searchTerm: string): string[] {
  return normalizeSearchText(searchTerm).trim().split(/\s+/).filter(Boolean);
}

export function historySearchTextMatches(
  searchText: string,
  tokens: readonly string[],
): boolean {
  return (
    tokens.length === 0 || tokens.some((token) => searchText.includes(token))
  );
}
