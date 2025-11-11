// Standard library imports
import * as path from 'path';

// Third-party imports
import { parse as parseBibTeX } from '@retorquere/bibtex-parser';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const DIRECTIVE_PATTERN_SOURCE =
  '\\(?:bibliography|addbibresource)(?:\\s*\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}';
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
    `\\(?:${CITE_COMMANDS.join('|')})\\*?(?:\\[[^\\]]*\\])*\{([^}]*)\}`,
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
  const directivePattern = createDirectivePattern();

  while ((match = directivePattern.exec(content)) !== null) {
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
  const citationPattern = createCitationPattern();

  while ((match = citationPattern.exec(content)) !== null) {
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
  const library = parseBibTeX(content);
  const entries = new Map<string, string>();

  for (const entry of library.entries) {
    const key = entry.key?.trim();
    if (!key || entries.has(key)) {
      continue;
    }

    entries.set(key, entry.input.trim());
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
  const requestedKeys = new Set(filteredKeys);

  for (const filePath of bibliographyFiles) {
    const content = await WorkspaceFS.read(filePath);
    const parsed = parseBibEntries(content);
    for (const [key, value] of parsed.entries()) {
      if (
        (hasWildcard || requestedKeys.size === 0 || requestedKeys.has(key)) &&
        !entries.has(key)
      ) {
        entries.set(key, value);
      }
    }
  }

  const missingKeys = filteredKeys.filter((key) => !entries.has(key));

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
