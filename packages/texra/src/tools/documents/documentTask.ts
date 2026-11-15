/**
 * The check a document task's first revision runs on its context files: a
 * bibliography too large to attach whole is refused before any model reads
 * it.
 */
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';
import { ToolError } from '@texra-ai/harness/plugins';
import { hasExtension } from '@texra-ai/harness/host';

/** The largest `.bib` a task attaches whole as context. */
const LARGE_BIB_LIMIT_BYTES = 100 * 1024;

/**
 * Fail a task's context that attaches an oversized bibliography file.
 * `workspaceRoot` is the owning session's workspace folder, handed in as
 * data so a relative path resolves against its own session.
 */
export const rejectOversizedBibAttachments = Effect.fn(
  'rejectOversizedBibAttachments',
)(function* (
  workspaceRoot: string | undefined,
  contextFiles: readonly string[],
): Effect.fn.Return<void, Error, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const bibFiles = contextFiles
    .filter((file) => file.trim() !== '')
    .filter((file) => hasExtension(file, '.bib'));

  for (const bibFile of bibFiles) {
    // A relative path names a workspace file, which needs a folder open.
    let absolute = bibFile;
    if (!path.isAbsolute(bibFile)) {
      if (!workspaceRoot) {
        return yield* Effect.fail(
          new Error('Workspace path is not available.'),
        );
      }
      absolute = path.join(workspaceRoot, bibFile);
    }
    // `FileSystem.stat` follows a link; a link whose target does not
    // resolve is measured as no file, as a path `readLink` cannot name is
    // no entry at all.
    const stats = yield* fs.stat(absolute).pipe(
      Effect.catch((error) =>
        fs.readLink(absolute).pipe(
          Effect.as(undefined),
          Effect.mapError(() => error),
        ),
      ),
    );
    if (stats === undefined) continue;
    if (Number(stats.size) <= LARGE_BIB_LIMIT_BYTES) continue;

    const sizeBytes = Number(stats.size);
    const message = `${bibFile} is ${sizeBytes} bytes, over the ${LARGE_BIB_LIMIT_BYTES} byte limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.`;
    return yield* Effect.fail(
      new ToolError(message, {
        summary: 'Rejected oversized BibTeX attachment',
      }),
    );
  }
});
