import { z } from 'zod';

import { getBasename } from '@utils/core';
import { DiffStatsSchema } from './lineChanges';
import { RunIdSchema } from './identifiers';

/** A zero-based round (a document task's revision) number. */
export const RoundNumberSchema = z.int().nonnegative();

const WorkspaceFileLocationSchema = z.strictObject({
  kind: z.literal('workspace'),
  absolutePath: z.string(),
  relativePath: z.string(),
});

const RunStorageFileLocationSchema = z.strictObject({
  kind: z.literal('runStorage'),
  absolutePath: z.string(),
  relativePath: z.string(),
  runId: RunIdSchema,
});

const ExternalFileLocationSchema = z.strictObject({
  kind: z.literal('external'),
  absolutePath: z.string(),
});

/** Discriminated union of all file location types */
export const FileLocationSchema = z.discriminatedUnion('kind', [
  WorkspaceFileLocationSchema,
  RunStorageFileLocationSchema,
  ExternalFileLocationSchema,
]);

export type WorkspaceFileLocation = z.infer<typeof WorkspaceFileLocationSchema>;
export type RunStorageFileLocation = z.infer<
  typeof RunStorageFileLocationSchema
>;
export type ExternalFileLocation = z.infer<typeof ExternalFileLocationSchema>;
export type FileLocation = z.infer<typeof FileLocationSchema>;

// ============================================================================
// How a file location reads to a human
// ============================================================================
//
// One vocabulary for turning a `FileLocation` into text, shared by the agent
// core, both webview hosts and the CLI TUI. It lives beside the schema rather
// than in `@utils/files` because the webviews cannot reach a module that
// imports `node:path`, and a browser-unreachable definition is exactly how
// this rule came to be re-derived in every renderer.

/**
 * How a location reads as a path: workspace and run-storage files by their
 * relative path — that is how the user and the agent's file tools refer to
 * them — and external files by their absolute path, the only path they have.
 *
 * This doubles as a location's comparable identity: two locations naming the
 * same file agree here, so output-to-base maps key on it.
 */
export function fileLocationDisplayPath(location: FileLocation): string {
  return location.kind === 'external'
    ? location.absolutePath
    : location.relativePath;
}

/**
 * Like {@link fileLocationDisplayPath} but collapses an external location to
 * its basename, so a long absolute path (e.g. a run-storage file resolved as
 * external because it sits outside the workspace root) cannot dominate a UI
 * row or a prompt line. The full path stays on `absolutePath`.
 */
export function fileLocationShortDisplayPath(location: FileLocation): string {
  return location.kind === 'external'
    ? getBasename(location.absolutePath)
    : location.relativePath;
}

/**
 * Reference to a run-storage file the way an agent prompt addresses it:
 * `/executions/<runId>/files/<relativePath>`. The one definition of that
 * convention.
 */
export function runStorageFilePath(
  runId: string,
  relativePath: string,
): string {
  return `/executions/${runId}/files/${relativePath}`;
}

/**
 * How a location is addressed in text that leaves the UI — copied run context,
 * follow-up prompts, subagent results. A run-storage location carries the
 * run that owns it, so its `/executions/...` route resolves without the
 * caller supplying one; every other kind reads as its display path.
 */
export function fileLocationAddressPath(location: FileLocation): string {
  return location.kind === 'runStorage'
    ? runStorageFilePath(location.runId, location.relativePath)
    : fileLocationDisplayPath(location);
}

const OutputFileSchema = z.strictObject({
  source: z.string(),
  location: FileLocationSchema,
});

const FileLineageSchema = z.strictObject({
  original: FileLocationSchema.nullable(),
  diffBase: FileLocationSchema.nullable(),
});

/** A file a document task wrote, with its lineage and diff stats: the
 *  documents plugin's record, which the latexdiff log payload
 *  (`diffResult.ts`) still names until that payload leaves the harness. */
export const OutputFileInfoSchema = OutputFileSchema.extend({
  round: RoundNumberSchema.prefault(() => 0),
  lineage: FileLineageSchema.nullable(),
  diff: DiffStatsSchema.nullable(),
});

export type OutputFileInfo = z.infer<typeof OutputFileInfoSchema>;
