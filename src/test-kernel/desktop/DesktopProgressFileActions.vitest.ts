import * as path from 'node:path';
import { Context, Effect } from 'effect';

import { describe, expect, it, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime';

import { DesktopProgressFileActions } from '@desktop/main/desktopProgressFileActions';
import type { DiffRunOutcome, DiffRunResult } from '@latex/latexdiff/types';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import { Rejected } from '@shared/session/requestErrors';

import { createStubDesktopAgentRunHost } from './desktopAgentRunTestHarness.ts';

// The desktop adapter delegates the read + dispatch to the shared
// host-neutral `runLatexdiffForRun`; mock it at that boundary so this suite
// covers the desktop outcome handling, not the core.
const latexdiff = vi.hoisted(() => ({
  runLatexdiffForRun: vi.fn(),
}));

vi.mock('@latex/latexdiff/diffOperations', () => ({
  runLatexdiffForRun: latexdiff.runLatexdiffForRun,
}));
vi.mock('@latex/latexdiff', () => ({
  LaTeXdiffService: class {},
}));
vi.mock('@utils/files/fileLocation', async (importActual) => ({
  ...(await importActual<typeof import('@utils/files/fileLocation')>()),
  createExternalLocation: (absolutePath: string) => ({
    kind: 'external',
    absolutePath,
  }),
}));

function absolutePath(...segments: string[]): string {
  return path.join(path.sep, ...segments);
}

/** A successful run whose diff landed beside `basePath`, as the service reports it. */
function successResult(
  basePath: string,
  diffFileName = 'main_diff.tex',
): DiffRunResult {
  return {
    success: true,
    diffPath: path.join(path.dirname(basePath), diffFileName),
    message: 'diff written',
    description: basePath,
  };
}

/** A failed run, as the shared core reports it. */
function failureResult(message: string): DiffRunResult {
  return { success: false, message, description: message };
}

function expectOpenedDiff(
  openBuildDisplay: ReturnType<typeof vi.fn>,
  absolutePath: string,
): void {
  expect(openBuildDisplay).toHaveBeenCalledWith({
    kind: 'external',
    absolutePath,
  });
}

const RUN_ID = 'exec-1' as RunId;

function loadFileActions(outcome: DiffRunOutcome): {
  actions: DesktopProgressFileActions;
  openBuildDisplay: ReturnType<typeof vi.fn>;
} {
  latexdiff.runLatexdiffForRun
    .mockReset()
    .mockImplementation(() => Effect.succeed(outcome));

  const openBuildDisplay = vi.fn(() => Effect.void);
  const actions = new DesktopProgressFileActions(
    {
      // The stub's error notice succeeds; this surface's binding refuses the
      // request, as the production one in `desktopHostRequests` does.
      ...createStubDesktopAgentRunHost({ openBuildDisplay }),
      showErrorMessage: (message) =>
        Effect.fail(new Rejected({ reason: message })),
    },
    {
      startRun: vi.fn(),
      listWorkspaceCandidateFiles: vi.fn(() => Effect.succeed([])),
      session: {
        snapshots: { read: vi.fn() },
        roots: { workspace: absolutePath('workspace') },
      } as unknown as SessionHandle,
      // Every latexdiff program this suite reaches is mocked, so the services
      // the actions take from the window's runtime are never read.
      runtime: {
        contextEffect: Effect.succeed(Context.empty()),
      } as unknown as ProcessRuntime,
    },
  );

  return { actions, openBuildDisplay };
}

describe('DesktopProgressFileActions latexdiff', () => {
  it('opens every successful diff, not just the first', async () => {
    const { actions, openBuildDisplay } = loadFileActions({
      results: [
        successResult(absolutePath('run', 'r1', 'main.tex')),
        successResult(absolutePath('run', 'r2', 'main.tex')),
        failureResult('one failed'),
      ],
    });

    await Effect.runPromise(actions.diffStreamToolbarAction(RUN_ID));

    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('run', 'r1', 'main_diff.tex'),
    );
    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('run', 'r2', 'main_diff.tex'),
    );
    expect(openBuildDisplay).toHaveBeenCalledTimes(2);
  });
});
