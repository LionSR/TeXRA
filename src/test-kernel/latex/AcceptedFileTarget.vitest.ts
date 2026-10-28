import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe, expect } from 'vitest';

import { AppSignals } from '@texra-ai/harness/host';
import { acceptEditedFileReplace } from '@latex/acceptedFileTarget';
import { createWorkspaceLocation } from '@utils/files/fileLocation';

describe('acceptEditedFileReplace', () => {
  it.effect(
    'does not delete the just-accepted file when it collides with the derived diff name',
    () =>
      Effect.gen(function* () {
        // base is literally named "<edited-stem>_diff.tex" — the same name
        // staleDiffFileLocation would derive for this edited/base pair — so the
        // write target and the "stale diff" coincide.
        const base = createWorkspaceLocation(
          path.join(path.sep, 'ws', 'paper_diff.tex'),
          'paper_diff.tex',
        );
        const edited = createWorkspaceLocation(
          path.join(path.sep, 'ws', 'paper.tex'),
          'paper.tex',
        );
        // Every path reads back the edited content and nothing exists until
        // written; removals are recorded for the stale-diff cleanup.
        const removed: string[] = [];
        const fs = {
          readFileString: () => Effect.succeed('edited content'),
          writeFileString: () => Effect.void,
          exists: () => Effect.succeed(false),
          remove: (absolutePath: string) =>
            Effect.sync(() => {
              removed.push(absolutePath);
            }),
        } as unknown as FileSystem.FileSystem;

        const accepted = yield* acceptEditedFileReplace(base, edited, {
          confirm: () => Effect.succeed(true),
          showInfo: () => Effect.void,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provide(AppSignals.layer),
        );

        expect(accepted).toBe(true);
        expect(removed).toEqual([]);
      }),
  );
});
