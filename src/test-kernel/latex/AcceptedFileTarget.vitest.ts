import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { describe, expect } from 'vitest';

import {
  acceptEditedFileReplace,
  type AcceptEditedFileReplacePorts,
} from '@latex/acceptedFileTarget';
import { createWorkspaceLocation } from '@utils/files/fileLocation';

function absolutePath(...segments: string[]): string {
  return path.join(path.sep, ...segments);
}

/**
 * The filesystem the accept programs read and write through: every path reads
 * back `edited content`, nothing exists until it is written, and the removals
 * are recorded so the stale-diff cleanup can be asserted on.
 */
function fakeFilesystem(): {
  written: Array<{ absolutePath: string; content: string }>;
  removed: string[];
  layer: Layer.Layer<FileSystem.FileSystem>;
} {
  const written: Array<{ absolutePath: string; content: string }> = [];
  const removed: string[] = [];
  const fs = {
    readFileString: () => Effect.succeed('edited content'),
    writeFileString: (absolutePath: string, content: string) =>
      Effect.sync(() => {
        written.push({ absolutePath, content });
      }),
    exists: () => Effect.succeed(false),
    remove: (absolutePath: string) =>
      Effect.sync(() => {
        removed.push(absolutePath);
      }),
  } as unknown as FileSystem.FileSystem;
  return {
    written,
    removed,
    layer: Layer.succeed(FileSystem.FileSystem)(fs),
  };
}

describe('acceptEditedFileReplace', () => {
  function buildPorts(
    overrides: Partial<AcceptEditedFileReplacePorts> = {},
  ): AcceptEditedFileReplacePorts {
    return {
      confirm: () => Effect.succeed(true),
      emitWritten: () => undefined,
      showInfo: () => Effect.void,
      ...overrides,
    };
  }

  it.effect(
    'does not delete the just-accepted file when it collides with the derived diff name',
    () =>
      Effect.gen(function* () {
        // base is literally named "<edited-stem>_diff.tex" — the same name
        // staleDiffFileLocation would derive for this edited/base pair — so the
        // write target and the "stale diff" coincide.
        const base = createWorkspaceLocation(
          absolutePath('ws', 'paper_diff.tex'),
          'paper_diff.tex',
        );
        const edited = createWorkspaceLocation(
          absolutePath('ws', 'paper.tex'),
          'paper.tex',
        );
        const filesystem = fakeFilesystem();

        const accepted = yield* acceptEditedFileReplace(
          base,
          edited,
          buildPorts(),
        ).pipe(Effect.provide(filesystem.layer));

        expect(accepted).toBe(true);
        expect(filesystem.removed).toEqual([]);
      }),
  );
});
