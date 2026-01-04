// Standard library imports
import * as path from 'path';

// Third-party imports
import { BibEntry, parseBibFile } from 'bibtex';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const DIRECTIVE_PATTERN_SOURCE =
  '(?:bibliography|addbibresource)(?:\\s*\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}';
const CITE_COMMANDS = [
  'cite',
  'citet',
  'citep',
  'textcite',
  'parencite',
  'footcite',
  'autocite',
  'nocite',
  'Cite',
  'Citet',
  'Citep',
  'Textcite',
  'Parencite',
  'Footcite',
];
function createDirectivePattern(): RegExp {
  return new RegExp(DIRECTIVE_PATTERN_SOURCE, 'g');
}

function createCitationPattern(): RegExp {
  return new RegExp(
    `\\\\(?:${CITE_COMMANDS.join('|')})\\*?(?:\\[[^\\]]*\\])*\{([^}]*)\}`,
    'g',
  );
}
const COMMENT_PATTERN = /(^|[^\\])%.*$/gm;

export interface BibliographyReferenceResult {
  /** Paths to bibliography files that exist, relative to the workspace. */
  bibliographyFiles: string[];
  /** Bibliography files referenced but not found. */
  missingBibliographyFiles: string[];
  /** Citation keys discovered in the LaTeX document. */
  citationKeys: string[];
}

export interface BibliographyEntriesResult {
  /** Map of citation key to raw BibTeX entry text. */
  entries: Map<string, string>;
  /** Citation keys without matching entries across the loaded files. */
  missingKeys: string[];
}

function stripComments(content: string): string {
  return content.replaceAll(COMMENT_PATTERN, '$1');
}

function normalizeBibPath(baseDir: string, target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    return '';
  }

  const withExtension = trimmed.endsWith('.bib') ? trimmed : `${trimmed}.bib`;
  const resolved = path.normalize(path.join(baseDir, withExtension));
  return resolved;
}

function collectBibliographyPaths(baseDir: string, content: string): string[] {
  const paths = new Set<string>();
  const directivePattern = createDirectivePattern();

  for (const match of content.matchAll(directivePattern)) {
    const block = match[1];
    for (const raw of block.split(',')) {
      const normalized = normalizeBibPath(baseDir, raw);
      if (normalized) {
        paths.add(normalized);
      }
    }
  }

  return [...paths];
}

function collectCitationKeys(content: string): string[] {
  const keys = new Set<string>();
  const citationPattern = createCitationPattern();

  for (const match of content.matchAll(citationPattern)) {
    const block = match[1];
    for (const raw of block.split(',')) {
      const key = raw.trim();
      if (key) {
        keys.add(key);
      }
    }
  }

  return [...keys];
}

export async function extractBibliographyContext(
  texPath: string,
): Promise<BibliographyReferenceResult> {
  const texDir = path.dirname(texPath);
  const content = await WorkspaceFS.read(texPath);
  const uncommented = stripComments(content);

  const referencedPaths = collectBibliographyPaths(texDir, uncommented);
  const existing: string[] = [];
  const missing: string[] = [];

  for (const candidate of referencedPaths) {
    if (await WorkspaceFS.exists(candidate)) {
      existing.push(candidate);
    } else {
      missing.push(candidate);
    }
  }

  const citationKeys = collectCitationKeys(uncommented);

  return {
    bibliographyFiles: existing,
    missingBibliographyFiles: missing,
    citationKeys,
  };
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '{}';
  }

  if (typeof value === 'number') {
    return value.toString();
  }

  if (typeof value === 'string') {
    return `{${value}}`;
  }

  if (typeof value === 'object') {
    const candidate = value as { type?: string; stringify?: () => string };
    if (typeof candidate.stringify === 'function') {
      const rendered = candidate.stringify();
      if (candidate.type === 'quotedstringwrapper') {
        return `"${rendered}"`;
      }

      return `{${rendered}}`;
    }

    return `{${String(value)}}`;
  }

  return `{${String(value)}}`;
}

function formatBibEntry(
  rawEntry: BibEntry,
  processedEntry?: BibEntry,
): string | null {
  const type = rawEntry.type?.trim();
  const key = rawEntry._id?.trim();

  if (!type || !key) {
    return null;
  }

  const lines: string[] = [`@${type}{${key},`];
  const fieldNames = Object.keys(rawEntry.fields);

  for (const fieldName of fieldNames) {
    const processedValue =
      processedEntry?.getField(fieldName) ?? rawEntry.fields[fieldName];
    const serialized = formatFieldValue(processedValue);
    lines.push(`  ${fieldName} = ${serialized},`);
  }

  if (fieldNames.length > 0) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = lines[lastIndex].replace(/,$/, '');
  }

  lines.push('}');
  return lines.join('\n');
}

function parseBibEntries(content: string): Map<string, string> {
  const library = parseBibFile(content);
  const entries = new Map<string, string>();

  for (const rawEntry of library.entries_raw) {
    const processedEntry =
      rawEntry._id !== undefined ? library.entries$[rawEntry._id] : undefined;
    const formatted = formatBibEntry(rawEntry, processedEntry);
    const key = rawEntry._id?.trim();

    if (!key || !formatted || entries.has(key)) {
      continue;
    }

    entries.set(key, formatted);
  }

  return entries;
}

export async function loadBibliographyEntries(
  bibliographyFiles: string[],
  citationKeys: string[],
): Promise<BibliographyEntriesResult> {
  const entries = new Map<string, string>();
  const hasWildcard = citationKeys.includes('*');
  const filteredKeys = citationKeys.filter((key) => key !== '*');
  const normalizedRequestedKeys = new Set(
    filteredKeys.map((key) => key.toLowerCase()),
  );
  const parsedEntries = new Map<string, { key: string; value: string }>();

  for (const filePath of bibliographyFiles) {
    const content = await WorkspaceFS.read(filePath);
    const parsed = parseBibEntries(content);
    for (const [key, value] of parsed.entries()) {
      const normalizedKey = key.toLowerCase();
      if (!parsedEntries.has(normalizedKey)) {
        parsedEntries.set(normalizedKey, { key, value });
      }
    }
  }

  if (hasWildcard || normalizedRequestedKeys.size === 0) {
    for (const { key, value } of parsedEntries.values()) {
      if (!entries.has(key)) {
        entries.set(key, value);
      }
    }
  } else {
    for (const originalKey of filteredKeys) {
      const normalizedKey = originalKey.toLowerCase();
      const matched = parsedEntries.get(normalizedKey);
      if (matched && !entries.has(originalKey)) {
        entries.set(originalKey, matched.value);
      }
    }
  }

  const missingKeys =
    hasWildcard || normalizedRequestedKeys.size === 0
      ? []
      : filteredKeys.filter((key) => !parsedEntries.has(key.toLowerCase()));

  return {
    entries,
    missingKeys,
  };
}

export function summarizeBibliographyEntries(
  entries: Map<string, string>,
  limit: number,
): string[] {
  const values = [...entries.values()];
  const limited = values.slice(0, limit);
  const lines: string[] = [];

  for (const entry of limited) {
    lines.push(entry);
    lines.push('');
  }

  if (lines.length > 0) {
    lines.pop();
  }

  return lines;
}
