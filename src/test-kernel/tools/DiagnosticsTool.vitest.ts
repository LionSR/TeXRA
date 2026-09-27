import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';

import { createTestSession } from '@test/support/sessionTestUtils';
import { createFakeHost } from '@test/support/setupPlatform';
import { DiagnosticsTool } from '@tools/DiagnosticsTool';

/** The test scope owns its session and exposes its tool capabilities directly. */
function withSession<A, E, R>(
  run: (session: SessionHandle) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(createTestSession),
    run,
    (session) => closeSessionOf(session),
  );
}

function addCriticismCall() {
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
  it.effect('resolves an added criticism in the invoking project scope', () =>
    Effect.gen(function* () {
      const project = createFakeHost({
        workspacePath: path.join(path.sep, 'project', 'diagnostics'),
      });
      const projectPath = path.join(project.roots.workspace!, 'paper.tex');

      yield* withSession((session) =>
        Effect.gen(function* () {
          const addCriticism = vi.fn((entry) => ({
            accepted: true,
            resolvedPath: entry.absolutePath,
          }));
          yield* session.interactions.use({ addCriticism });

          const result = yield* DiagnosticsTool.call(addCriticismCall()).pipe(
            Effect.provide(
              nativeToolTestLayer({
                run: {
                  session,
                  runId: 'diagnostics-project-scope' as RunId,
                  toolPolicy: {},
                },
                roots: project.roots,
              }),
            ),
          );

          expect(addCriticism).toHaveBeenCalledWith(
            expect.objectContaining({ absolutePath: projectPath }),
          );
          expect(result.summary).toBe(
            `Added criticism for ${projectPath}:3 (S4/C5)`,
          );
        }),
      );
    }),
  );
});
