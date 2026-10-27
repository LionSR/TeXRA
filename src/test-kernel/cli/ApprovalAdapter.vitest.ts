// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';
import { afterEach, describe, expect } from 'vitest';

let detachHostInteractions = (): void => {};

import { createHeadlessCliHostInteractions } from '@cli/runtime/approvalAdapter';
import type { CliContext } from '@cli/runtime/cliContext';
import { type CliApprovalPromptHooks } from '@cli/runtime/approval/approvalPrompts';
import { type RunId } from '@shared/schemas';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  publishTestRunStart,
  setTestApprovalPolicy,
} from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';

function context(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    cwd: '/tmp',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    ...overrides,
  });
}

function useCliHostInteractions(
  cliContext: CliContext,
  hooks: CliApprovalPromptHooks = {},
): void {
  detachHostInteractions();
  setTestApprovalPolicy(cliContext.approvalPolicy);
  // The host's view watch lives in this scope; detaching closes it.
  const scope = Scope.makeUnsafe();
  const detach = Effect.runSync(
    testDefaultSession().interactions.use(
      testRuntime().runSync(
        createHeadlessCliHostInteractions(
          testSessionOf(testDefaultSession()),
          cliContext,
          hooks,
        ).pipe(Scope.provide(scope)),
      ),
    ),
  );
  detachHostInteractions = () => {
    detach();
    Effect.runFork(Scope.close(scope, Exit.void));
  };
}

const ROOT_RUN = 'a00001' as RunId;
/** The runs this file opens requests on; a request is a row on its run, so
 *  the run exists before the first one opens. */
const started = new Set<RunId>();

function ensureRun(runId: RunId) {
  return Effect.gen(function* () {
    if (started.has(runId)) return;
    started.add(runId);
    publishTestRunStart(testDefaultSession(), runId);
    yield* testDefaultSession().log.settled;
  });
}

/** A tool's edit approval request for `path` on the root run. */
function requestEdit(path: string, proposedContent: string) {
  return Effect.gen(function* () {
    yield* ensureRun(ROOT_RUN);
    return yield* requestToolEditApproval({
      path,
      originalContent: '',
      proposedContent,
      sourceTool: 'write_file',
      runId: ROOT_RUN,
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          workingDirectory: '/tmp',
          run: {
            runId: ROOT_RUN,
            session: testDefaultSession(),
            toolPolicy: {},
          },
        }),
      ),
    );
  });
}

afterEach(() => {
  detachHostInteractions();
  detachHostInteractions = () => {};
});

describe('approval prompt hooks', () => {
  it.effect(
    'denies a request still listed pending when the run has nobody to ask',
    () =>
      Effect.gen(function* () {
        // A request opened before the host changed is listed pending; a
        // prompt on a closed stdin would never settle it.
        const prompted: string[] = [];
        useCliHostInteractions(
          context({
            mode: 'headless',
            approvalPrompt: () =>
              Effect.sync(() => {
                prompted.push('prompt');
                return 'y';
              }),
          }),
          {
            prompting: () => {
              prompted.push('before');
              return () => {};
            },
          },
        );
        yield* ensureRun(ROOT_RUN);
        const result = yield* testDefaultSession().requests.ask(ROOT_RUN, {
          kind: 'proposal',
          data: {
            requestId: 'proposal-1',
            runId: ROOT_RUN,
            agent: 'review',
            model: 'deepseek/deepseek-v4-flash',
            instruction: 'Please check this proof.',
            memories: [],
            inputFiles: [],
            contextFiles: [],
            mediaFiles: [],
            outputFiles: [],
            task: false,
            options: {},
          },
        });

        expect(result).toMatchObject({ action: 'deny' });
        expect(prompted).toEqual([]);
      }),
  );
});

describe('buildToolEditApprovalContent', () => {
  it.effect('preserves a failed edit prompt as an automatic cancellation', () =>
    Effect.gen(function* () {
      useCliHostInteractions(
        context({
          approvalPrompt: () => Effect.fail(new Error('terminal input closed')),
        }),
      );

      const result = yield* requestEdit(
        '/tmp/new-proof.tex',
        '\\section{Proof}\nA concise proof.\n',
      );

      // A prompt that never reached a person closes the request as an
      // automatic cancellation, never as that person's rejection.
      expect(result).toEqual({
        action: 'cancel',
        cause: 'CLI approval prompt failed: terminal input closed',
      });
    }),
  );

  it.effect('skips prompting for auto-approved edits', () =>
    Effect.gen(function* () {
      useCliHostInteractions(
        context({
          approvalPolicy: 'yolo',
          approvalPrompt: () =>
            Effect.die(new Error('approval prompt should not be called')),
        }),
      );

      const result = yield* requestEdit(
        '/tmp/auto-approved.tex',
        '\\section{Auto-approved}\n',
      );

      expect(result).toMatchObject({
        action: 'apply',
        appliedContent: '\\section{Auto-approved}\n',
      });
    }),
  );
});
