// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Named import only: bibtex's UMD exports carry `__esModule: true`, so a
// default import bundles to `undefined` under esbuild's ESM interop and the
// destructure crashes at module init (0.39.10 startup-crash).
import { parseBibFile } from 'bibtex';

// Local imports - utils
import { ensureError } from '@utils/errors/errorMessage';
import { WorkspaceFS } from '@utils/files/workspaceFS';

// Local file imports
import {
  collectBibliographyPaths,
  collectCommaSeparatedMatches,
  LATEX_CITATION_COMMANDS,
  stripLatexComments,
} from './latexParsingUtils';

// Third-party imports - types
import type { BibEntry } from 'bibtex';

// Compiled regex patterns (matchAll clones the regex, so module-level is safe)
const CITATION_PATTERN = new RegExp(
  `\\\\(?:${LATEX_CITATION_COMMANDS.join('|')})\\*?(?:\\[[^\\]]*\\])*\\{([^}]*)\\}`,
  'g',
);

interface BibliographyReferenceResult {
  /** Paths to bibliography files that exist, relative to the workspace. */
  bibliographyFiles: string[];
  /** Bibliography files referenced but not found. */
  missingBibliographyFiles: string[];
  /** Citation keys discovered in the LaTeX document. */
  citationKeys: string[];
}

interface BibliographyEntriesResult {
  /** Map of citation key to raw BibTeX entry text. */
  entries: Map<string, string>;
  /** Citation keys without matching entries across the loaded files. */
  missingKeys: string[];
}

/** Bibliography probes hit the filesystem, so bound the fan-out. */
const PROBE_CONCURRENCY = 8;

/** Read a workspace-relative file, surfacing the read failure as a typed error. */
const readWorkspaceFile = Effect.fn('latex.readWorkspaceFile')(function* (
  filePath: string,
) {
  return yield* Effect.tryPromise({
    try: () => WorkspaceFS.read(filePath),
    catch: ensureError,
  });
});

export const extractBibliographyContext = Effect.fn(
  'latex.extractBibliographyContext',
)(function* (
  texPath: string,
): Effect.fn.Return<BibliographyReferenceResult, Error> {
  const texDir = path.dirname(texPath);
  const content = yield* readWorkspaceFile(texPath);
  const uncommented = stripLatexComments(content);

  const referencedPaths = collectBibliographyPaths(texDir, uncommented);
  const probed = yield* Effect.forEach(
    referencedPaths,
    (candidate) =>
      Effect.tryPromise({
        try: () => WorkspaceFS.exists(candidate),
        catch: ensureError,
      }).pipe(Effect.map((exists) => ({ candidate, exists }))),
    { concurrency: PROBE_CONCURRENCY },
  );
  const pathsWhere = (exists: boolean): string[] =>
    probed.filter((entry) => entry.exists === exists).map((e) => e.candidate);

  const citationKeys = collectCommaSeparatedMatches(
    uncommented,
    CITATION_PATTERN,
  );

  return {
    bibliographyFiles: pathsWhere(true),
    missingBibliographyFiles: pathsWhere(false),
    citationKeys,
  };
});

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

export const loadBibliographyEntries = Effect.fn(
  'latex.loadBibliographyEntries',
)(function* (
  bibliographyFiles: readonly string[],
  citationKeys: readonly string[],
): Effect.fn.Return<BibliographyEntriesResult, Error> {
  // Citation keys are matched case-insensitively; the first definition of a
  // key across the bibliography files wins, so the files are read as one
  // bounded fan-out and folded back in their declared order.
  const contents = yield* Effect.forEach(bibliographyFiles, readWorkspaceFile, {
    concurrency: PROBE_CONCURRENCY,
  });

  const parsedEntries = new Map<string, { key: string; value: string }>();
  for (const content of contents) {
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
});

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
