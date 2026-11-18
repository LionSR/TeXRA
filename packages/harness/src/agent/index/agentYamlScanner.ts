/** Stateless YAML scanning for the agent registry. */

import * as path from 'node:path';

import { glob } from 'glob';

import { Effect, FileSystem, Order, Result, Schema, SchemaIssue } from 'effect';
import { safeParseYaml } from '@common/parsing/safeParseYaml';
import { withLogChannel } from '@logger/effectLog';
import {
  AGENT_FILE_EXTENSION,
  AgentDefinitionSchema,
  PersonaSchema,
  type AgentDefinition,
} from '@shared/schemas';
import type { AgentScanIssue, CatalogAgentSource } from '@shared/schemas';
import { truncatedHexId } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';
import type { AgentEntry } from './agentEntry';

const CHANNEL = 'agentRegistry';

/**
 * One file- or directory-level scan failure. Scanning is a best-effort
 * projection: a bad YAML file becomes an issue entry and an unreadable
 * root becomes one issue that contributes no files, so the error never escapes
 * `scanDirectory`'s channel — it exists to be recovered from, and the channel
 * is `never` at the export. Defects (programming errors) stay defects.
 */
class AgentScanError extends Schema.TaggedError<AgentScanError>()(
  'AgentScanError',
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

interface AgentDirectoryScan {
  readonly entries: AgentEntry[];
  readonly issues: AgentScanIssue[];
}

interface ParsedAgentYaml {
  readonly name: string;
  readonly path: string;
  /** The scanned root the file was found under; issues name paths from it. */
  readonly root: string;
  readonly definition: AgentDefinition;
  readonly digest: string;
}

/**
 * Scan one agent source. A source can span several roots (the bundled
 * tool-use source is the core directory plus each tool plugin's), and they are
 * pooled into one scan, so names stay unique across the whole source. Files
 * list in absolute-path order, as one directory holding
 * them all would list them. A root that cannot be listed is one issue and
 * drops only its own files.
 */
export function scanDirectory(
  roots: readonly string[],
  source: CatalogAgentSource,
): Effect.Effect<AgentDirectoryScan, never, FileSystem.FileSystem> {
  const dirs = roots.filter((root) => root !== '');
  if (dirs.length === 0) return Effect.succeed({ entries: [], issues: [] });

  return Effect.gen(function* () {
    const issues: AgentScanIssue[] = [];
    // Each file with the root it was found under; a path two roots share
    // keeps the first.
    const rootOf = new Map<string, string>();
    // The roots are listed concurrently, then merged in `dirs` order.
    const listings = yield* Effect.forEach(
      dirs,
      (root) =>
        Effect.map(
          Effect.result(
            Effect.tryPromise({
              try: () =>
                glob(`**/*${AGENT_FILE_EXTENSION}`, {
                  cwd: root,
                  absolute: true,
                  nodir: true,
                }),
              catch: (cause) =>
                new AgentScanError({
                  path: root,
                  message: toErrorMessage(cause),
                  cause,
                }),
            }),
          ),
          (listed) => ({ root, listed }),
        ),
      { concurrency: 8 },
    );
    for (const { root, listed } of listings) {
      if (Result.isFailure(listed)) {
        const { message } = listed.failure;
        yield* Effect.logError(`Failed to scan ${root}: ${message}`).pipe(
          withLogChannel(CHANNEL),
        );
        issues.push({ path: root, message });
        continue;
      }
      for (const yamlPath of listed.success) {
        if (!rootOf.has(yamlPath)) rootOf.set(yamlPath, root);
      }
    }
    const [parsed, unreadable] = yield* Effect.partition(
      // Code-unit order, which the default sort gave one directory's paths.
      [...rootOf].toSorted(([a], [b]) => Order.String(a, b)),
      ([yamlPath, root]) => readYamlDefinition(yamlPath, root),
      { concurrency: 8 },
    );
    issues.push(
      ...unreadable.map((failure) => ({
        path: failure.path,
        message: failure.message,
      })),
    );
    const entries: AgentEntry[] = [];
    for (const entry of yield* entriesWithUniqueNames(parsed, issues)) {
      const scanned = yield* Effect.result(scanYaml(entry, source));
      if (Result.isSuccess(scanned)) {
        entries.push(scanned.success);
        continue;
      }
      yield* Effect.logWarning(
        `Failed to scan ${entry.path}: ${scanned.failure.message}`,
      ).pipe(withLogChannel(CHANNEL));
      issues.push({
        path: path.relative(entry.root, entry.path),
        message: scanned.failure.message,
      });
    }

    yield* Effect.logDebug(
      `Scanned ${entries.length} agents from ${source}`,
    ).pipe(withLogChannel(CHANNEL));
    return { entries, issues };
  });
}

const entriesWithUniqueNames = Effect.fn('entriesWithUniqueNames')(function* (
  entries: readonly ParsedAgentYaml[],
  issues: AgentScanIssue[],
): Effect.fn.Return<ParsedAgentYaml[]> {
  const byName = Map.groupBy(entries, (entry) => entry.name);

  const unique: ParsedAgentYaml[] = [];
  for (const [name, matches] of byName) {
    if (matches.length > 1) {
      const paths = matches.map((entry) => entry.path).join(', ');
      yield* Effect.logWarning(
        `Duplicate agent name "${name}" in ${paths}; skipping all duplicates.`,
      ).pipe(withLogChannel(CHANNEL));
      for (const match of matches) {
        issues.push({
          path: path.relative(match.root, match.path),
          message: `Duplicate agent name "${name}".`,
        });
      }
      continue;
    }
    unique.push(matches[0]);
  }
  return unique;
});

function readYamlDefinition(
  yamlPath: string,
  dir: string,
): Effect.Effect<ParsedAgentYaml, AgentScanError, FileSystem.FileSystem> {
  const displayPath = path.relative(dir, yamlPath);
  const scanError = (cause: unknown) =>
    new AgentScanError({
      path: displayPath,
      message: formatScanFailure(cause),
      cause,
    });
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* readNormalizedFile(fs, yamlPath).pipe(
      Effect.mapError(scanError),
    );
    // A key the definition does not declare is refused.
    const parsed = Result.flatMap(safeParseYaml(content), (value) =>
      Schema.decodeUnknownResult(AgentDefinitionSchema)(value, {
        onExcessProperty: 'error',
        errors: 'all',
      }),
    );
    if (Result.isFailure(parsed)) return yield* scanError(parsed.failure);
    const definition = parsed.success;
    return {
      name: definition.name,
      path: yamlPath,
      root: dir,
      definition,
      digest: truncatedHexId(content, 12),
    };
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`Failed to scan ${yamlPath}: ${error.message}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
  );
}

/** Marks an unrecognized key's issue so the keys are listed together. */
const UNRECOGNIZED_KEY = 'unrecognized key';
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === 'UnexpectedKey'
      ? UNRECOGNIZED_KEY
      : SchemaIssue.defaultLeafHook(issue),
});

/** A schema failure as one line: every issue at its path, the unrecognized
 *  keys listed together as one. */
function formatScanFailure(error: unknown): string {
  if (!(error instanceof Schema.SchemaError)) return toErrorMessage(error);
  const { issues } = formatIssues(error.issue);
  const unrecognized = issues
    .filter(({ message }) => message === UNRECOGNIZED_KEY)
    .map(({ path }) => (path ?? []).map(String).join('.'));
  const formatted = issues
    .filter(({ message }) => message !== UNRECOGNIZED_KEY)
    .map(({ path, message }) => {
      const where = (path ?? []).map(String).join('.');
      return where ? `${where}: ${message}` : message;
    });
  if (unrecognized.length)
    formatted.push(`unrecognized keys ${unrecognized.join(', ')}`);
  return formatted.length ? formatted.join('; ') : error.message;
}

/**
 * The entry a definition makes: its persona with the schema's defaults
 * applied, the one validation a launch reads, for a file and an inline
 * persona alike. Throws the validation's error.
 */
export function agentEntryOf(
  // As written (a file's tools are parsed, an inline persona's are names).
  definition: typeof AgentDefinitionSchema.Encoded,
  at: Pick<AgentEntry, 'source' | 'path' | 'digest'>,
): AgentEntry {
  const { name, description, basedOn, ...fields } = definition;
  const persona = Schema.decodeUnknownSync(PersonaSchema)(fields);
  return {
    name,
    ...at,
    description,
    basedOn,
    persona,
  };
}

/** The entry a definition file makes. */
function scanYaml(
  entry: ParsedAgentYaml,
  source: CatalogAgentSource,
): Effect.Effect<AgentEntry, AgentScanError> {
  return Effect.try({
    try: (): AgentEntry =>
      agentEntryOf(entry.definition, {
        source,
        path: entry.path,
        digest: entry.digest,
      }),
    catch: (cause) =>
      new AgentScanError({
        path: entry.path,
        message: formatScanFailure(cause),
        cause,
      }),
  });
}
