import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';

import { createTestSession } from '@test/support/sessionTestUtils';
import { DiagnosticsTool, type DiagnosticsInput } from '@tools/DiagnosticsTool';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';

const WORKTREE_PATH = path.join(path.sep, 'worktree');
const PAPER_PATH = path.join(WORKTREE_PATH, 'paper.tex');

/** The test scope owns its session and exposes its tool capabilities directly. */
function withSession<A, E, R>(
  run: (session: SessionHandle) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(createTestSession),
    run,
    (session) => Effect.sync(() => session.dispose()),
  );
}

function addCriticismCall(): Extract<DiagnosticsInput, { command: 'add' }> {
  return {
    command: 'add',
    path: 'paper.tex',
    line: 3,
    message: 'tighten this claim',
    severity: 4,
    confidence: 5,
  };
}

describe('DiagnosticsTool', () => {
  it.effect.each([
    {
      name: 'reports a capability error when the session has no diagnostics reader',
      input: { command: 'list', path: 'paper.tex' } as DiagnosticsInput,
      message: 'Diagnostics capability unavailable',
    },
    {
      name: 'reports a capability error when the session has no criticism sink',
      input: addCriticismCall(),
      message: 'Diagnostics add capability unavailable',
    },
  ])('$name', ({ input, message }) =>
    Effect.gen(function* () {
      yield* withSession((session) =>
        Effect.gen(function* () {
          const result = yield* new DiagnosticsTool().call(input).pipe(
            Effect.provide(
              nativeToolTestLayer({
                workingDirectory: WORKTREE_PATH,
                run: {
                  session,
                  runId: 'diagnostics-test' as RunId,
                  toolPolicy: {},
                },
              }),
            ),
          );

          expect(result).toMatchObject({
            status: 'error',
            diagnostics: { name: 'ToolError' },
          });
          expect(result.error).toContain(message);
        }),
      );
    }),
  );

  it.effect('reads diagnostics through the run context session', () =>
    Effect.gen(function* () {
      yield* withSession((session) =>
        Effect.gen(function* () {
          const readDiagnostics = vi.fn(async (_path: string) => {
            return [] as GenericDiagnostic[];
          });
          session.interactions.use({ readDiagnostics });

          const result = yield* new DiagnosticsTool()
            .call({ command: 'list', path: 'paper.tex' })
            .pipe(
              Effect.provide(
                nativeToolTestLayer({
                  workingDirectory: WORKTREE_PATH,
                  run: {
                    session,
                    runId: 'diagnostics-test' as RunId,
                    toolPolicy: {},
                  },
                }),
              ),
            );

          expect(readDiagnostics).toHaveBeenCalledWith(PAPER_PATH);
          expect(result.diagnostics).toMatchObject({
            path: PAPER_PATH,
            command: 'list',
          });
        }),
      );
    }),
  );

  it.effect(
    'reports when the criticism sink does not accept (feature disabled)',
    () =>
      Effect.gen(function* () {
        yield* withSession((session) =>
          Effect.gen(function* () {
            session.interactions.use({
              addCriticism: () => ({ accepted: false, resolvedPath: '' }),
            });

            const result = yield* new DiagnosticsTool()
              .call(addCriticismCall())
              .pipe(
                Effect.provide(
                  nativeToolTestLayer({
                    workingDirectory: WORKTREE_PATH,
                    run: {
                      session,
                      runId: 'diagnostics-test' as RunId,
                      toolPolicy: {},
                    },
                  }),
                ),
              );

            expect(result.summary).toBe('Criticism not accepted');
          }),
        );
      }),
  );

  it.effect('resolves the path and summarizes an accepted criticism', () =>
    Effect.gen(function* () {
      yield* withSession((session) =>
        Effect.gen(function* () {
          const entries: unknown[] = [];
          session.interactions.use({
            addCriticism: (entry) => {
              entries.push(entry);
              return { accepted: true, resolvedPath: entry.absolutePath };
            },
          });

          const result = yield* new DiagnosticsTool()
            .call(addCriticismCall())
            .pipe(
              Effect.provide(
                nativeToolTestLayer({
                  workingDirectory: WORKTREE_PATH,
                  run: {
                    session,
                    runId: 'diagnostics-test' as RunId,
                    toolPolicy: {},
                  },
                }),
              ),
            );

          expect(entries).toEqual([
            {
              absolutePath: PAPER_PATH,
              line: 3,
              message: 'tighten this claim',
              severity: 4,
              confidence: 5,
            },
          ]);
          expect(result.summary).toBe(
            `Added criticism for ${PAPER_PATH}:3 (S4/C5)`,
          );
        }),
      );
    }),
  );
});
