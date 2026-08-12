// Standard library imports
import * as path from 'node:path';

// Third-party imports
// Named import only: bibtex's UMD exports carry `__esModule: true`, so a
// default import bundles to `undefined` under esbuild's ESM interop and the
// destructure crashes at module init (0.39.10 startup-crash).
import { parseBibFile } from 'bibtex';

// Local imports - utils
import { WorkspaceFS } from '@utils/files/workspaceFS';

// Local file imports
import {
  collectBibliographyPaths,
  collectCommaSeparatedMatches,
  stripLatexComments,
} from './latexParsingUtils';

// Third-party imports - types
import type { BibEntry } from 'bibtex';

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

// Compiled regex patterns (matchAll clones the regex, so module-level is safe)
const CITATION_PATTERN = new RegExp(
  `\\\\(?:${CITE_COMMANDS.join('|')})\\*?(?:\\[[^\\]]*\\])*\\{([^}]*)\\}`,
  'g',
);

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

export async function extractBibliographyContext(
  texPath: string,
): Promise<BibliographyReferenceResult> {
  const texDir = path.dirname(texPath);
  const content = await WorkspaceFS.read(texPath);
  const uncommented = stripLatexComments(content);

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

  const citationKeys = collectCommaSeparatedMatches(
    uncommented,
    CITATION_PATTERN,
  );

  return {
    bibliographyFiles: existing,
    missingBibliographyFiles: missing,
    citationKeys,
  };
}

function formatFieldValue(value: unknown): string {
  if (value == null) {
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
      return candidate.type === 'quotedstringwrapper'
        ? `"${rendered}"`
        : `{${rendered}}`;
    }
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

  const fields = Object.entries(rawEntry.fields).map(
    ([fieldName, rawValue]) => {
      const processedValue = processedEntry?.getField(fieldName) ?? rawValue;
      return `  ${fieldName} = ${formatFieldValue(processedValue)}`;
    },
  );

  const lines = [`@${type}{${key},`];
  if (fields.length > 0) {
    lines.push(fields.join(',\n'));
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
  // Citation keys are matched case-insensitively; the first definition of a
  // key across the bibliography files wins.
  const parsedEntries = new Map<string, { key: string; value: string }>();
  for (const filePath of bibliographyFiles) {
    const content = await WorkspaceFS.read(filePath);
    for (const [key, value] of parseBibEntries(content)) {
      const normalizedKey = key.toLowerCase();
      if (!parsedEntries.has(normalizedKey)) {
        parsedEntries.set(normalizedKey, { key, value });
      }
    }
  }

  const requestedKeys = citationKeys.filter((key) => key !== '*');
  const includeAll = citationKeys.includes('*') || requestedKeys.length === 0;

  const entries = new Map<string, string>();
  if (includeAll) {
    for (const { key, value } of parsedEntries.values()) {
      entries.set(key, value);
    }
    return { entries, missingKeys: [] };
  }

  const missingKeys: string[] = [];
  for (const requestedKey of requestedKeys) {
    const matched = parsedEntries.get(requestedKey.toLowerCase());
    if (matched) {
      entries.set(requestedKey, matched.value);
    } else {
      missingKeys.push(requestedKey);
    }
  }

  return { entries, missingKeys };
}

export function summarizeBibliographyEntries(
  entries: Map<string, string>,
  limit: number,
): string[] {
  const values = [...entries.values()].slice(0, limit);
  // Join entries with empty lines between them
  return values.flatMap((entry, i) =>
    i < values.length - 1 ? [entry, ''] : [entry],
  );
}
