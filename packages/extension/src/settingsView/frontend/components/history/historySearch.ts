import type { HistoryItem } from '@shared/schemas';

import {
  getHistoryItemPresentation,
  hasHistoryConfigValue,
  type HistoryConfigValue,
} from './historyItemPresentation';

type ToolConfigEntry = [string, HistoryConfigValue];

function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
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
): void {
  if (!hasHistoryConfigValue(value)) return;

  parts.push(label);
  addSearchValue(parts, value);
}

function addConfigSection(
  parts: string[],
  sectionLabel: string,
  entries: ToolConfigEntry[],
): boolean {
  const visibleEntries = entries.filter(([, value]) =>
    hasHistoryConfigValue(value),
  );
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
  const presentation = getHistoryItemPresentation(item);
  const parts: string[] = [
    presentation.id,
    presentation.rawTimestamp,
    presentation.timestamp,
  ];
  addSearchValue(parts, presentation.description);

  parts.push('Category', presentation.decorator.label);
  // Index the status enum value alongside the badge text. The badge is the only
  // status a row renders, so indexing just its label would silently break every
  // saved search the moment that wording is edited.
  parts.push('Status', presentation.status.label, item.status);
  parts.push('Agent');
  addSearchValue(parts, presentation.agent);
  parts.push('Model');
  addSearchValue(parts, presentation.model);
  parts.push('Instruction');
  addSearchValue(parts, presentation.instruction ?? 'Not set');

  addLabelledValue(parts, 'InputFiles', presentation.inputFiles);
  addLabelledValue(parts, 'MediaFiles', presentation.mediaFiles);
  const hasMoreDetails = presentation.sections
    .map((section) => addConfigSection(parts, section.label, section.entries))
    .some(Boolean);
  if (hasMoreDetails) {
    parts.push('More details');
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
