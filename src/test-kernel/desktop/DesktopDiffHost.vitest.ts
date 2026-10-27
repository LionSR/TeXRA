// Standard library imports
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeAll, describe, expect, vi } from 'vitest';

// Local imports - test support
import { testRuntime } from '@test/support/testProcessRuntime';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

type DesktopDiffHostModule = typeof import('@desktop/main/desktopDiffHost');
type DiffHostOptions = Parameters<
  DesktopDiffHostModule['createDesktopDiffHost']
>[0];
type DiffHost = ReturnType<
  ReturnType<DesktopDiffHostModule['createDesktopDiffHost']>['inProject']
>;

// The Review pane a diff lands in is keyed by the project's storage root, which
// the window binds per open project rather than reading off the caller.
const REVIEW_ROOTS = { storage: '/projects/paper/.texra' };

let createDesktopDiffHost: DesktopDiffHostModule['createDesktopDiffHost'];
let removeExternalDiffPatchDirs: DesktopDiffHostModule['removeExternalDiffPatchDirs'];

// Every case needs the external-editor fallback observable, so the harness owns
// `openPath` and the paths it received. `afterEach` removes the recorded patch
// directories the way the desktop quit lifecycle does.
function createHost(overrides: Partial<DiffHostOptions> = {}) {
  const openedPaths: string[] = [];
  const openPath = vi.fn((filePath: string): Effect.Effect<void, Error> =>
    Effect.sync(() => {
      openedPaths.push(filePath);
    }),
  );
  const host = createDesktopDiffHost({
    runtime: testRuntime(),
    openPath,
    ...overrides,
  }).inProject(REVIEW_ROOTS);
  return {
    host,
    openPath,
    openedPaths,
  };
}

const tempDirs = useTempDirs();

afterEach(async () => {
  await testRuntime().runPromise(removeExternalDiffPatchDirs);
});

type OpenDiffArgs = Parameters<DiffHost['openDiff']>;
type OpenDiffSources = [OpenDiffArgs[0], OpenDiffArgs[1]];

async function prepareDiffPair(
  names: [string, string] = ['a.tex', 'b.tex'],
  texts: [string, string] = ['a\n', 'b\n'],
): Promise<OpenDiffSources> {
  const tempDir = await makeTempDir('texra-diff-host-test-', tempDirs);
  const originalPath = path.join(tempDir, names[0]);
  const proposedPath = path.join(tempDir, names[1]);
  await Promise.all([
    writeFile(originalPath, texts[0], 'utf8'),
    writeFile(proposedPath, texts[1], 'utf8'),
  ]);
  return [{ filePath: originalPath }, { filePath: proposedPath }];
}

/** The window's run: `openDiff` is the program the caller settles. */
async function openDiffPair(
  host: DiffHost,
  title: string,
  names: [string, string] = ['a.tex', 'b.tex'],
  texts: [string, string] = ['a\n', 'b\n'],
): Promise<void> {
  const [original, proposed] = await prepareDiffPair(names, texts);
  await testRuntime().runPromise(host.openDiff(original, proposed, title));
}

describe('createDesktopDiffHost', () => {
  // The dynamic import pulls the full desktop main graph through the module
  // runner; keep the hook timeout generous for cold combined test runs.
  beforeAll(async () => {
    ({ createDesktopDiffHost, removeExternalDiffPatchDirs } =
      await import('@desktop/main/desktopDiffHost'));
  }, 60_000);

  it('removes the patch directory immediately when the editor fails to open', async () => {
    const failure = new Error('editor unavailable');
    const { host, openPath } = createHost();
    // The member is a program, so the refusal is its failure, not a rejection.
    openPath.mockReturnValue(Effect.fail(failure));

    // The open failure reaches the caller, carrying the host's own rejection,
    // and not a cleanup artifact.
    await expect(openDiffPair(host, 'Compare')).rejects.toMatchObject({
      _tag: 'ExternalOpenFailed',
      kind: 'path',
      cause: failure,
    });

    expect(openPath).toHaveBeenCalledTimes(1);
    const diffDir = path.dirname(openPath.mock.calls[0][0]);
    expect(path.basename(diffDir)).toMatch(/^texra-desktop-diff-/);
    expect(existsSync(diffDir)).toBe(false);
  });
});
