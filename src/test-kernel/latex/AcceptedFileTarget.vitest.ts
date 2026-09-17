import * as path from 'node:path';

import { Effect, FileSystem, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import {
  acceptEditedFileReplace,
  commitAcceptedFile,
  type AcceptEditedFileReplacePorts,
  type CommitAcceptedFilePorts,
} from '@latex/acceptedFileTarget';
import type { FileLocation } from '@shared/schemas';
import { createWorkspaceLocation } from '@utils/files/fileLocation';

function absolutePath(...segments: string[]): string {
  return path.join(path.sep, ...segments);
}

/** The canonical base/edited pair most cases below are built on. */
function paperPair(): { base: FileLocation; edited: FileLocation } {
  return {
    base: createWorkspaceLocation(absolutePath('ws', 'paper.tex'), 'paper.tex'),
    edited: createWorkspaceLocation(
      absolutePath('ws', 'paper_correct.tex'),
      'paper_correct.tex',
    ),
  };
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

  it('cleans up the stale diff file after a successful accept', async () => {
    const { base, edited } = paperPair();
    const filesystem = fakeFilesystem();

    const accepted = await Effect.runPromise(
      acceptEditedFileReplace(base, edited, buildPorts()).pipe(
        Effect.provide(filesystem.layer),
      ),
    );

    expect(accepted).toBe(true);
    expect(filesystem.removed).toEqual([
      absolutePath('ws', 'paper_correct_diff.tex'),
    ]);
  });

  it('does not clean up when the user declines the confirmation', async () => {
    const { base, edited } = paperPair();
    const filesystem = fakeFilesystem();

    const accepted = await Effect.runPromise(
      acceptEditedFileReplace(
        base,
        edited,
        buildPorts({ confirm: () => Effect.succeed(false) }),
      ).pipe(Effect.provide(filesystem.layer)),
    );

    expect(accepted).toBe(false);
    expect(filesystem.removed).toEqual([]);
    expect(filesystem.written).toEqual([]);
  });

  it('does not delete the just-accepted file when it collides with the derived diff name', async () => {
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

    const accepted = await Effect.runPromise(
      acceptEditedFileReplace(base, edited, buildPorts()).pipe(
        Effect.provide(filesystem.layer),
      ),
    );

    expect(accepted).toBe(true);
    expect(filesystem.removed).toEqual([]);
  });

  it('does not clean up the base diff when accepting into a new sibling (extension mismatch)', async () => {
    // Different extensions -> getAcceptedFileTarget resolves to a new
    // sibling file, leaving base untouched, so its diff is still accurate.
    const { base } = paperPair();
    const edited = createWorkspaceLocation(
      absolutePath('ws', 'notes.md'),
      'notes.md',
    );
    const filesystem = fakeFilesystem();

    const accepted = await Effect.runPromise(
      acceptEditedFileReplace(base, edited, buildPorts()).pipe(
        Effect.provide(filesystem.layer),
      ),
    );

    expect(accepted).toBe(true);
    expect(filesystem.removed).toEqual([]);
  });
});

describe('commitAcceptedFile', () => {
  it('writes the edited content into the resolved target and reports success', async () => {
    const { base, edited } = paperPair();
    const copy = createWorkspaceLocation(
      absolutePath('ws', 'paper_copy.tex'),
      'paper_copy.tex',
    );
    const filesystem = fakeFilesystem();
    const infoMessages: string[] = [];
    const ports: CommitAcceptedFilePorts = {
      emitWritten: () => undefined,
      showInfo: (message) =>
        Effect.sync(() => {
          infoMessages.push(message);
        }),
    };

    await Effect.runPromise(
      commitAcceptedFile(
        base,
        edited,
        { targetLocation: copy, targetFileName: 'paper_copy.tex' },
        false,
        ports,
      ).pipe(Effect.provide(filesystem.layer)),
    );

    expect(filesystem.written).toEqual([
      { absolutePath: copy.absolutePath, content: 'edited content' },
    ]);
    expect(infoMessages).toEqual([expect.stringMatching(/created/)]);
  });
});
