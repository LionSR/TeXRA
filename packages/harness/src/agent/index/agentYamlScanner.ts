/** Stateless YAML scanning for the agent registry. */

import * as path from 'node:path';

import { glob } from 'glob';
import { ZodError, type z, type ZodIssue } from 'zod';

import { Data, Effect, FileSystem, Result } from 'effect';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import { withLogChannel } from '@logger/effectLog';
import {
  AgentDefinitionSchema,
  DocumentTaskSchema,
  PersonaSchema,
  type AgentDefinition,
} from '@shared/schemas';
import type { AgentSource } from '@shared/schemas';
import type { AgentScanIssue } from '@shared/schemas';
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
class AgentScanError extends Data.TaggedError('AgentScanError')<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
 * pooled into one scan, so names stay unique and `inherits` resolves across
 * the whole source. Files list in absolute-path order, as one directory holding
 * them all would list them. A root that cannot be listed is one issue and
 * drops only its own files.
 */
export function scanDirectory(
  roots: readonly string[],
  source: AgentSource,
): Effect.Effect<AgentDirectoryScan, never, FileSystem.FileSystem> {
  const dirs = roots.filter((root) => root !== '');
  if (dirs.length === 0) return Effect.succeed({ entries: [], issues: [] });

  return Effect.gen(function* () {
    const issues: AgentScanIssue[] = [];
    // Each file with the root it was found under; a path two roots share
    // keeps the first.
    const rootOf = new Map<string, string>();
    for (const root of dirs) {
      const listed = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            glob('**/*.yaml', { cwd: root, absolute: true, nodir: true }),
          catch: (cause) =>
            new AgentScanError({
              path: root,
              message: toErrorMessage(cause),
              cause,
            }),
        }),
      );
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
    const parsed: ParsedAgentYaml[] = [];
    for (const result of yield* Effect.forEach(
      // Code-unit order, which the default sort gave one directory's paths.
      [...rootOf].toSorted(([a], [b]) => Number(a > b) - Number(a < b)),
      ([yamlPath, root]) => Effect.result(readYamlDefinition(yamlPath, root)),
      { concurrency: 8 },
    )) {
      if (Result.isSuccess(result)) parsed.push(result.success);
      else {
        issues.push({
          path: result.failure.path,
          message: result.failure.message,
        });
      }
    }
    const unique = yield* entriesWithUniqueNames(parsed, issues);
    const definitions = new Map(
      unique.map((entry) => [entry.name, entry] as const),
    );
    const entries: AgentEntry[] = [];
    for (const entry of unique) {
      const scanned = yield* Effect.result(
        scanYaml(entry, source, definitions),
      );
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

function entriesWithUniqueNames(
  entries: readonly ParsedAgentYaml[],
  issues: AgentScanIssue[],
): Effect.Effect<ParsedAgentYaml[]> {
  return Effect.gen(function* () {
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
}

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
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => readNormalizedFile(fs, yamlPath)),
    Effect.mapError(scanError),
  ).pipe(
    Effect.flatMap((content) => {
      const parsed = parseYamlWith(content, AgentDefinitionSchema);
      if (Result.isFailure(parsed)) {
        return Effect.fail(scanError(parsed.failure));
      }
      return Effect.succeed({
        name: parsed.success.name,
        path: yamlPath,
        root: dir,
        definition: parsed.success,
        digest: truncatedHexId(content, 12),
      });
    }),
    Effect.tapError((error) =>
      Effect.logWarning(`Failed to scan ${yamlPath}: ${error.message}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
  );
}

function formatScanFailure(error: unknown): string {
  if (error instanceof ZodError) {
    const formatted = error.issues.map(formatSchemaIssue).filter(Boolean);
    if (formatted.length) return formatted.join('; ');
  }
  return toErrorMessage(error);
}

function formatSchemaIssue(issue: ZodIssue): string {
  const where = issue.path.join('.');
  const prefix = where ? `${where}: ` : '';
  if (issue.code === 'unrecognized_keys') {
    return `${prefix}unrecognized keys ${issue.keys.join(', ')}`;
  }
  return issue.message ? `${prefix}${issue.message}` : '';
}

/** The fields a file inherits: everything but its identity and its stamp. */
type InheritedFields = Omit<
  AgentDefinition,
  'name' | 'description' | 'inherits' | 'basedOn'
>;

/**
 * The definition's own fields with its `inherits` chain merged in: the
 * parent gives defaults and the child overrides (a `task` block merges field
 * by field, a list replaces the parent's). The chain is looked up by name in
 * the same source's scan, so a parent that is absent or a chain that loops
 * is an error of this file, reported as its issue, never a listed agent that
 * fails at launch.
 */
function inheritedFields(
  entry: ParsedAgentYaml,
  definitions: Map<string, ParsedAgentYaml>,
  seen: readonly string[] = [entry.name],
): InheritedFields {
  const {
    name: _name,
    description: _description,
    inherits: parentName,
    basedOn: _basedOn,
    ...own
  } = entry.definition;
  if (!parentName) return own;

  const parent = definitions.get(parentName);
  if (!parent) {
    throw new Error(
      `Unable to locate parent agent "${parentName}" in the same directory.`,
    );
  }
  if (seen.includes(parent.name)) {
    throw new Error(
      `Circular "inherits" chain detected: ${[...seen, parent.name].join(' -> ')}.`,
    );
  }
  return mergeInheritedAgentObject(
    inheritedFields(parent, definitions, [...seen, parent.name]),
    own,
  );
}

/**
 * The entry a definition makes, its inheritance already merged: its persona
 * and task with the schema's defaults applied, the one validation a launch
 * reads, for a file and an inline persona alike. A task's persona works
 * text-only: the recipe owns extraction, compilation and the proposal, so a
 * definition that names tools beside a task is refused rather than run with
 * tools it would never be offered. Throws the validation's error.
 */
export function agentEntryOf(
  // As written (a file's tools are parsed, an inline persona's are names).
  definition: Omit<z.input<typeof AgentDefinitionSchema>, 'inherits'>,
  at: Pick<AgentEntry, 'source' | 'path' | 'digest'>,
): AgentEntry {
  const {
    name,
    description,
    basedOn,
    task: taskFields,
    ...fields
  } = definition;
  const persona = PersonaSchema.parse(fields);
  const task =
    taskFields === undefined ? null : DocumentTaskSchema.parse(taskFields);
  if (task !== null && persona.tools.length > 0)
    throw new Error(
      'A document task works text-only, so `tools` and `task` cannot be combined: remove one.',
    );
  const tools = persona.tools.map((tool) => tool.name);
  return {
    name,
    ...at,
    description,
    tools: tools.length ? tools : undefined,
    rounds: task?.requests.length,
    basedOn,
    persona,
    task,
  };
}

/** The entry a definition file makes, with its inheritance chain merged. */
function scanYaml(
  entry: ParsedAgentYaml,
  source: AgentSource,
  definitions: Map<string, ParsedAgentYaml>,
): Effect.Effect<AgentEntry, AgentScanError> {
  return Effect.try({
    try: (): AgentEntry =>
      agentEntryOf(
        {
          ...inheritedFields(entry, definitions),
          name: entry.name,
          description: entry.definition.description,
          basedOn: entry.definition.basedOn,
        },
        { source, path: entry.path, digest: entry.digest },
      ),
    catch: (cause) =>
      new AgentScanError({
        path: entry.path,
        message: formatScanFailure(cause),
        cause,
      }),
  });
}
