// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer, Context, Schema } from 'effect';
import { describe, expect } from 'vitest';

import { RunIdSchema, type RunId } from '@texra-ai/harness/schemas';
import { Interactions } from '@agent/runtime/HostInteractions';
import { SessionRequests } from '@agent/runtime/requestPolicy';
import { type CliApprovalPromptHooks } from '@cli/runtime/approval/approvalPrompts';
import type { CliContext } from '@cli/runtime/cliContext';
import { createHeadlessCliHostInteractions } from '@cli/runtime/approvalAdapter';
import { SessionLog } from '@shared/session/runHistory';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  publishTestRunStart,
  setTestApprovalPolicy,
} from '@test/support/sessionTestUtils';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

function context(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    cwd: '/tmp',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    ...overrides,
  });
}

/** The session's internal handle: its requests, interactions and log. */
const sessionHandle = Effect.flatMap(TestSession, sessionHandleOf);

/**
 * The CLI's host interactions attached to the session for the test's scope:
 * the host's view watch lives in that scope, and the scope's close detaches
 * them first.
 */
const useCliHostInteractions = (
  cliContext: CliContext,
  hooks: CliApprovalPromptHooks = {},
) =>
  Effect.gen(function* () {
    setTestApprovalPolicy(cliContext.approvalPolicy);
    const session = yield* TestSession;
    const handle = yield* sessionHandle;
    const interactions = yield* createHeadlessCliHostInteractions(
      session,
      cliContext,
      hooks,
    );
    yield* Effect.acquireRelease(
      Context.get(handle, Interactions).use(interactions),
      (detach) => Effect.sync(detach),
    );
  });

const ROOT_RUN = Schema.decodeUnknownSync(RunIdSchema)('a00001');
/** The runs this file opens requests on; a request is a row on its run, so
 *  the run exists before the first one opens. */
const started = new Set<RunId>();

function ensureRun(runId: RunId) {
  return Effect.gen(function* () {
    if (started.has(runId)) return;
    started.add(runId);
    const handle = yield* sessionHandle;
    publishTestRunStart(handle, runId);
    yield* Context.get(handle, SessionLog).settled;
  });
}

// One session for the file: the runs it starts stay started across its cases.
layer(Layer.provideMerge(TestSession.layer(), SessionGraph.hosted))(
  'CLI approval adapter',
  (it) => {
    describe('approval prompt hooks', () => {
      it.effect(
        'denies a request still listed pending when the run has nobody to ask',
        () =>
          Effect.gen(function* () {
            // A request opened before the host changed is listed pending; a
            // prompt on a closed stdin would never settle it.
            const prompted: string[] = [];
            yield* useCliHostInteractions(
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
            const handle = yield* sessionHandle;
            const result = yield* Context.get(handle, SessionRequests).ask(
              ROOT_RUN,
              {
                kind: 'proposal',
                data: {
                  requestId: 'proposal-1',
                  allowBypass: true,
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
              },
            );

            expect(result).toMatchObject({ action: 'deny' });
            expect(prompted).toEqual([]);
          }),
      );
    });
  },
);
