/**
 * Headless delegation over a real session on the validation host: the
 * `agent` tool and the in-band path launch the bundled `review` persona as a
 * real child of a parked parent, which answers on the validation model and
 * settles its report, result manifest and end through the real lifecycle.
 * Store faults stand in for the write failures and races a case needs.
 *
 * Failure modes:
 * - an awaited child's typed result is returned while its manifest never
 *   landed;
 * - a caller stop during persistence rewrites a completed result;
 * - a proposal is approved or asked under the `never` policy;
 * - a detached child's result is delivered to the parent that released it.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Exit, Fiber, Schema, Stream } from 'effect';
import { describe, expect } from 'vitest';

import '@test/support/sessionGraphTestSetup';

import { humanGrant } from '@agent/runtime/runApprovalQueue';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withProcessServices } from '@platform/processRuntime';
import {
  AgentConfigSchema,
  type RequestDecision,
  type RunId,
} from '@shared/schemas';
import {
  nativeToolTestLayer,
  testModelCell,
} from '@test/support/nativeToolTestLayer';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import {
  publishTestRows,
  queuedFollowUps,
  setTestApprovalPolicy,
} from '@test/support/sessionTestUtils';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  claimHolder,
  parkedRoot,
  REAL_RUN_TIMEOUT,
  sessionStoreFaults,
  storedRows,
  untilStored,
  validationHost,
  type StoredRow,
} from '@test/support/storeFaults';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { agentTool } from '@tools/delegation/AgentTool';
import { executeSubagentInBand } from '@tools/delegation/inBandSubagentRun';
import { generateRunId } from '@utils/core';

/** The parent's model, which its children inherit: the validation model
 *  answers it, and the host's OpenAI key makes it available. It is not the
 *  first model that key makes available, the one a child falls back to. */
const MODEL = 'openai/gpt-5.6-terra';

interface Parent {
  readonly session: SessionHandle;
  readonly runId: RunId;
  readonly storage: string;
}

/** A parked root run in the file's default session, the parent every case
 *  delegates from; `bypass` grants it the proposal bypass. */
const parkedParent = (bypass = true) =>
  Effect.gen(function* () {
    const roots = testWorkspaceRoots();
    const session = yield* openTestDefaultSession({ roots });
    const runId = yield* parkedRoot(session, 'Parent.');
    if (bypass)
      yield* session.approvals.change(runId, humanGrant(['superYolo'], true));
    return { session, runId, storage: roots.storage } satisfies Parent;
  });

/** The `agent` tool's call to `review` under `parent`'s run. */
const delegateReview = (parent: Parent, prompt = 'Check the proof.') =>
  agentTool()
    .call({ agentName: 'review', prompt })
    .pipe(
      Effect.provide(
        nativeToolTestLayer({
          // The child's run id derives from the call's id.
          callId: `call-${crypto.randomUUID()}`,
          run: {
            runId: parent.runId,
            session: parent.session,
            config: Schema.decodeUnknownSync(AgentConfigSchema)({
              agent: 'assistant',
              model: MODEL,
            }),
            model: testModelCell(MODEL),
            toolPolicy: {},
          },
        }),
      ),
    );

/** The in-band path a script's awaited `agent()` takes. */
const runInBand = (parent: Parent, runId: RunId) =>
  executeSubagentInBand({
    runId,
    configPayload: {
      agent: 'review',
      model: MODEL,
      instruction: 'Check the proof.',
    },
    parentRunId: parent.runId,
    session: parent.session,
  }).pipe(Effect.provideService(Runs, parent.session.runs), (program) =>
    withProcessServices(testRuntime(), program),
  );

/** The child runs `parent` launched, from the store. */
const childrenOf = (parent: Parent) =>
  storedRows(parent.storage)
    .filter((row) => row.type === 'run.start' && row.parent === parent.runId)
    .map((row) => row.run);

/** `run`'s newest stored row of `type`, decoded. */
const rowOf = (
  storage: string,
  run: string,
  type: string,
): Record<string, unknown> | undefined => {
  const row = storedRows(storage).findLast(
    (r: StoredRow) => r.run === run && r.type === type,
  );
  return row && (JSON.parse(row.data) as Record<string, unknown>);
};

/**
 * Answer every request the session opens the way a surface's
 * `request.decide` does, and record the kinds asked for, so a case can
 * assert that nothing was asked at all.
 */
const answerOpenedRequests = (
  session: SessionHandle,
  decision: RequestDecision,
) =>
  Effect.gen(function* () {
    const openedKinds: string[] = [];
    yield* Stream.runForEach(session.log.tail(session.log.now()), (event) =>
      Effect.sync(() => {
        if (event.type !== 'request.opened') return;
        openedKinds.push(event.payload.kind);
        publishTestRows(session, [
          {
            type: 'request.decided',
            aggregateId: event.aggregateId,
            requestId: event.requestId,
            decision,
          },
        ]);
      }),
    ).pipe(Effect.forkScoped);
    return openedKinds;
  });

/** An instruction whose model call the validation model holds until
 *  {@link releasePark}. */
const PARKED = 'GOLDEN-PARK Check the proof.';

/** Wait until `parent`'s child has a model call in flight. */
const untilAttempt = (parent: Parent) =>
  Effect.gen(function* () {
    yield* untilStored(parent.storage, (rows) =>
      rows.some(
        (row) =>
          row.type === 'model.message' &&
          row.data.includes('"kind":"attempt"') &&
          childrenOf(parent).includes(row.run),
      ),
    );
    // cast: a child's stored id is the run id it was launched under.
    return childrenOf(parent)[0]! as RunId;
  });

/** Release the validation model's GOLDEN-PARK hold. */
const releasePark = (parent: Parent) =>
  Effect.sync(() =>
    writeFileSync(join(parent.storage, 'golden-park.release'), ''),
  );

describe('headless delegation', { timeout: REAL_RUN_TIMEOUT }, () => {
  validationHost('texra-delegation-');

  it.live(
    'composes durable workflow calls through the native launch primitive',
    () =>
      Effect.gen(function* () {
        const parent = yield* parkedParent();
        const runId = generateRunId();
        // The child holds its claim until its manifest is durable: another
        // process taking it in between would find nothing to recover.
        const faults = yield* sessionStoreFaults(parent.storage);
        const persisting = yield* faults.holdNext('appendAll', 'run.result');
        const running = yield* Effect.forkChild(runInBand(parent, runId));
        yield* persisting.reached;
        expect(claimHolder(parent.storage, runId)).not.toBeNull();
        yield* persisting.release;
        const result = yield* Fiber.join(running);

        const rows = storedRows(parent.storage).filter(
          (row) => row.run === result.runId,
        );
        expect(rowOf(parent.storage, result.runId, 'run.start')).toMatchObject({
          identity: { kind: 'agent', agent: 'review' },
          parent: { id: parent.runId },
        });
        expect(result.result.outcome).toBe('completed');
        // The report and the manifest are durable once the call returns,
        // and the child let its claim go.
        expect(rows.map((row) => row.type)).toEqual(
          expect.arrayContaining(['run.report', 'run.result', 'run.end']),
        );
        expect(claimHolder(parent.storage, result.runId)).toBeNull();
        expect(
          rowOf(parent.storage, result.runId, 'run.result')?.result,
        ).toEqual({ producer: 'subagent', output: result.result.output });
      }),
  );

  it.live(
    'keeps the completed child result when the caller stops during persistence',
    () =>
      Effect.gen(function* () {
        const parent = yield* parkedParent();
        const faults = yield* sessionStoreFaults(parent.storage);
        const persisting = yield* faults.holdNext('appendAll', 'run.result');
        const runId = generateRunId();

        const running = yield* Effect.forkChild(runInBand(parent, runId));
        yield* persisting.reached;
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(running), {
          startImmediately: true,
        });
        yield* persisting.release;

        yield* Fiber.join(interrupting);
        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        expect(rowOf(parent.storage, runId, 'run.result')).toMatchObject({
          result: { producer: 'subagent' },
        });
        expect(rowOf(parent.storage, runId, 'run.end')).toMatchObject({
          outcome: 'completed',
        });
      }),
  );

  it.live(
    'denies a proposal under the never policy, as every other request kind',
    () =>
      Effect.gen(function* () {
        // Failure modes: `never` approves the proposal because the run
        // cannot present prompts, or opens a prompt nobody may answer.
        const parent = yield* parkedParent(false);
        setTestApprovalPolicy('never');
        yield* parent.session.interactions.use({
          approvalPromptsUnavailable: true,
        });
        const opened = yield* answerOpenedRequests(parent.session, {
          action: 'approve',
        });

        const result = yield* delegateReview(parent);

        expect(opened).toEqual([]);
        expect(result.status).toBe('error');
        expect(childrenOf(parent)).toEqual([]);
      }),
  );

  it.live(
    'does not deliver detached subagent results back to the released parent',
    () =>
      Effect.gen(function* () {
        const parent = yield* parkedParent();
        yield* Effect.addFinalizer(() => releasePark(parent));
        // The validation model holds the child's turn; the parent releases
        // its children mid-turn, as a stop-with-detach does.
        yield* delegateReview(parent, PARKED);
        const child = yield* untilAttempt(parent);
        const registry = registryOf(parent.session.runs);
        yield* registry['detachActiveChildren'](parent.runId);
        yield* releasePark(parent);

        yield* untilStored(parent.storage, (rows) =>
          rows.some((row) => row.run === child && row.type === 'run.report'),
        );
        expect(parent.session.view.run(child)?.parentId).toBeNull();
        expect(yield* queuedFollowUps(parent.session, parent.runId)).toEqual(
          [],
        );
      }),
  );
});
