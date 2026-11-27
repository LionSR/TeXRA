import { Schema } from 'effect';

import { RunIdSchema } from './identifiers';

const WorkspaceFileLocationSchema = Schema.Struct({
  kind: Schema.Literal('workspace'),
  absolutePath: Schema.String,
  relativePath: Schema.String,
});

const RunStorageFileLocationSchema = Schema.Struct({
  kind: Schema.Literal('runStorage'),
  absolutePath: Schema.String,
  relativePath: Schema.String,
  runId: RunIdSchema,
});

const ExternalFileLocationSchema = Schema.Struct({
  kind: Schema.Literal('external'),
  absolutePath: Schema.String,
});

/** Discriminated union of all file location types */
export const FileLocationSchema = Schema.Union([
  WorkspaceFileLocationSchema,
  RunStorageFileLocationSchema,
  ExternalFileLocationSchema,
]);

export type RunStorageFileLocation =
  (typeof RunStorageFileLocationSchema)['Type'];
export type FileLocation = typeof FileLocationSchema.Type;

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
