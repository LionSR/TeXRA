/** Stateless YAML scanning for the agent registry. */

import * as path from 'node:path';

import { glob } from 'glob';
import { ZodError, type ZodIssue } from 'zod';

import { Data, Effect, FileSystem, Result } from 'effect';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import {
  AgentDefinitionSchema,
  AgentWorkflowSettingSchema,
  type AgentDefinition,
} from '@agent/core/definition/AgentDataclass';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import { withLogChannel } from '@logger/effectLog';
import type { AgentSource } from '@shared/schemas';
import type { AgentScanIssue } from '@shared/settingsView/settingsViewMessages';
import { AgentCategory } from '@shared/schemas';
import { groupBy } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';
import type { AgentEntry } from './agentEntry';

const CHANNEL = 'agentRegistry';

/**
 * One file- or directory-level scan failure. Scanning is a best-effort
 * projection: a bad YAML file becomes an issue entry and an unreadable
 * directory becomes an empty scan with one issue, so the error never escapes
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
}

/**
 * Extract tool names from declared tool configs. An entry is a registry name,
 * or — for definitions registered as values — a whole tool definition.
 */
export function extractToolNames(
  rawTools: unknown[] | undefined,
): string[] | undefined {
  return rawTools?.flatMap((t) => {
    if (typeof t === 'string') return t;
    const name = (t as Record<string, unknown>)?.name;
    return typeof name === 'string' ? name : [];
  });
}

/**
 * Scan one agent source. A source can span several roots (the bundled
 * tool-use source is the core directory plus each tool plugin's), and they are
 * pooled into one scan, so names stay unique and `inherits` resolves across
 * the whole source. Files list in absolute-path order, as one directory holding
 * them all would list them.
 */
export function scanDirectory(
  roots: readonly string[],
  source: AgentSource,
): Effect.Effect<AgentDirectoryScan, never, FileSystem.FileSystem> {
  const dirs = roots.filter((root) => root !== '');
  if (dirs.length === 0) return Effect.succeed({ entries: [], issues: [] });

  return Effect.gen(function* () {
    const files = (yield* Effect.forEach(dirs, (root) =>
      Effect.tryPromise({
        try: () =>
          glob('**/*.yaml', {
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
      }).pipe(
        Effect.map((paths) => paths.map((yamlPath) => ({ root, yamlPath }))),
      ),
    ))
      .flat()
      // Code-unit order, as the default sort of one directory's paths gave.
      .toSorted((a, b) => (a.yamlPath < b.yamlPath ? -1 : 1));
    const issues: AgentScanIssue[] = [];
    const parsed: ParsedAgentYaml[] = [];
    for (const result of yield* Effect.forEach(
      files,
      ({ root, yamlPath }) => Effect.result(readYamlDefinition(yamlPath, root)),
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
  }).pipe(
    Effect.catch((error: AgentScanError) =>
      Effect.logError(`Failed to scan ${error.path}: ${error.message}`).pipe(
        withLogChannel(CHANNEL),
        Effect.as({
          entries: [],
          issues: [{ path: error.path, message: error.message }],
        }),
      ),
    ),
  );
}

function entriesWithUniqueNames(
  entries: readonly ParsedAgentYaml[],
  issues: AgentScanIssue[],
): Effect.Effect<ParsedAgentYaml[]> {
  return Effect.gen(function* () {
    const byName = groupBy(entries, (entry) => entry.name);

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

type InheritedBlockName = 'prompts' | 'settings';

interface InheritedDefinitionBlock<T> {
  readonly value: T;
  readonly complete: boolean;
}

function inheritedDefinitionBlock<B extends InheritedBlockName>(
  entry: ParsedAgentYaml,
  definitions: Map<string, ParsedAgentYaml>,
  block: B,
  seen: ReadonlySet<string> = new Set([entry.name]),
): InheritedDefinitionBlock<AgentDefinition[B]> {
  // Parameterizing over the block name (not the value type) lets this index
  // without a cast: `AgentDefinitionSchema` pins `entry.definition[block]` to
  // exactly `AgentDefinition[B]`, so passing the wrong block name for a given
  // T is no longer expressible.
  const ownBlock = entry.definition[block];
  const parentName = entry.definition.inherits;
  if (!parentName) return { value: ownBlock, complete: true };

  const parent = definitions.get(parentName);
  if (!parent || seen.has(parent.name)) {
    return { value: ownBlock, complete: false };
  }

  const inherited = inheritedDefinitionBlock(
    parent,
    definitions,
    block,
    new Set([...seen, parent.name]),
  );
  return {
    value: mergeInheritedAgentObject(inherited.value, ownBlock),
    complete: inherited.complete,
  };
}

/** Round floor for a workflow agent: one round per `userRequest` template. */
export function userRequestTemplateCount(userRequest: unknown): number {
  if (Array.isArray(userRequest)) return userRequest.length;
  return typeof userRequest === 'string' && userRequest ? 1 : 0;
}

function scanYaml(
  entry: ParsedAgentYaml,
  source: AgentSource,
  definitions: Map<string, ParsedAgentYaml>,
): Effect.Effect<AgentEntry, AgentScanError> {
  // A malformed `rounds` is dropped, not fatal: the scan reports it once the
  // entry is built.
  let malformedRounds: string | undefined;
  return Effect.try({
    try: () => {
      const settingsBlock = inheritedDefinitionBlock(
        entry,
        definitions,
        'settings',
      );
      const promptsBlock = inheritedDefinitionBlock(
        entry,
        definitions,
        'prompts',
      );
      const rawSettings = settingsBlock.value;
      const rawPrompts = promptsBlock.value;
      const defaultOutputFiles = rawSettings.defaultOutputFiles;

      const tools = extractToolNames(rawSettings.tools);

      const rawCategory = rawSettings.agentCategory;
      const category =
        source === 'builtInToolUse' || rawCategory === AgentCategory.ToolUse
          ? AgentCategory.ToolUse
          : AgentCategory.Workflow;

      let rounds: number | undefined;
      if (
        category === AgentCategory.Workflow &&
        settingsBlock.complete &&
        promptsBlock.complete
      ) {
        const parsedRounds = AgentWorkflowSettingSchema.shape.rounds.safeParse(
          rawSettings.rounds,
        );
        if (parsedRounds.success) {
          rounds = Math.max(
            parsedRounds.data,
            userRequestTemplateCount(rawPrompts.userRequest),
          );
        } else {
          malformedRounds = `Ignoring malformed rounds in ${entry.path}: ${toErrorMessage(parsedRounds.error)}`;
        }
      }

      return {
        name: entry.name,
        source,
        path: entry.path,
        category,
        description: entry.definition.description,
        tools: tools?.length ? tools : undefined,
        defaultOutputFiles: defaultOutputFiles?.length
          ? defaultOutputFiles
          : undefined,
        rounds,
      };
    },
    catch: (cause) =>
      new AgentScanError({
        path: entry.path,
        message: toErrorMessage(cause),
        cause,
      }),
  }).pipe(
    Effect.tap(() =>
      malformedRounds === undefined
        ? Effect.void
        : Effect.logWarning(malformedRounds).pipe(withLogChannel(CHANNEL)),
    ),
  );
}
