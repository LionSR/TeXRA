// Standard library imports
import * as path from 'path';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const DIRECTIVE_PATTERN =
  /\\(?:bibliography|addbibresource)(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/g;
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
const CITATION_PATTERN = new RegExp(
  `\\(?:${CITE_COMMANDS.join('|')})\\*?(?:\\[[^\\]]*\\])*\{([^}]*)\}`,
  'g',
);
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
  return content.replace(COMMENT_PATTERN, '$1');
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
  let match: RegExpExecArray | null;

  while ((match = DIRECTIVE_PATTERN.exec(content)) !== null) {
    const block = match[1];
    for (const raw of block.split(',')) {
      const normalized = normalizeBibPath(baseDir, raw);
      if (normalized) {
        paths.add(normalized);
      }
    }
  }

  return Array.from(paths);
}

function collectCitationKeys(content: string): string[] {
  const keys = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = CITATION_PATTERN.exec(content)) !== null) {
    const block = match[1];
    for (const raw of block.split(',')) {
      const key = raw.trim();
      if (key) {
        keys.add(key);
      }
    }
  }

  return Array.from(keys);
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

function parseBibEntries(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  const entryPattern = /@([\w-]+)\s*(\{|\()/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(content)) !== null) {
    const startIndex = match.index;
    const delimiter = match[2];
    const openChar = delimiter;
    const closeChar = delimiter === '{' ? '}' : ')';
    let depth = 1;
    let cursor = entryPattern.lastIndex;

    while (cursor < content.length && depth > 0) {
      const char = content[cursor];
      if (char === openChar) {
        depth += 1;
      } else if (char === closeChar) {
        depth -= 1;
      }
      cursor += 1;
    }

    if (depth !== 0) {
      entryPattern.lastIndex = cursor;
      continue;
    }

    const entryText = content.slice(startIndex, cursor).trim();
    const keyMatch = entryText.match(/@[^({]*[({]\s*([^,\s]+)\s*,/);
    if (!keyMatch) {
      entryPattern.lastIndex = cursor;
      continue;
    }

    const key = keyMatch[1].trim();
    if (!entries.has(key)) {
      entries.set(key, entryText);
    }

    entryPattern.lastIndex = cursor;
  }

  return entries;
}

export async function loadBibliographyEntries(
  bibliographyFiles: string[],
  citationKeys: string[],
): Promise<BibliographyEntriesResult> {
  const entries = new Map<string, string>();
  const requestedKeys = new Set(citationKeys);

  for (const filePath of bibliographyFiles) {
    const content = await WorkspaceFS.read(filePath);
    const parsed = parseBibEntries(content);
    for (const [key, value] of parsed.entries()) {
      if (
        (requestedKeys.size === 0 || requestedKeys.has(key)) &&
        !entries.has(key)
      ) {
        entries.set(key, value);
      }
    }
  }

  const missingKeys = citationKeys.filter((key) => !entries.has(key));

  return {
    entries,
    missingKeys,
  };
}

export function summarizeBibliographyEntries(
  entries: Map<string, string>,
  limit: number,
): string[] {
  const values = Array.from(entries.values());
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
