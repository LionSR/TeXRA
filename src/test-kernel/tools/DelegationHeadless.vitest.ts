/**
 * Headless delegation over a real session on the validation host: the
 * `agent` tool and the in-band path launch the bundled `review` persona as a
 * real child of a parked parent, which answers on the validation model and
 * settles its report, result manifest and end through the real lifecycle.
 * Store faults stand in for the write failures and races a case needs.
 *
 * Failure modes:
 * - an awaited child's typed result is returned while its manifest never
 *   landed, or a child's failure is lost when its manifest fails too;
 * - interrupting the caller leaves the child running, or registers one that
 *   never started;
 * - a caller stop during persistence rewrites a completed result;
 * - the child is launched without its source, its handoff guidance or the
 *   parent's constraint context;
 * - a proposal is approved, denied or asked against the run's policy, or an
 *   unavailable model override is launched;
 * - a detached child's result is delivered to the parent that released it.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Exit, Fiber, Stream } from 'effect';
import { describe, expect } from 'vitest';

import '@test/support/sessionGraphTestSetup';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { humanGrant } from '@agent/runtime/runApprovalQueue';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withProcessServices } from '@platform/processRuntime';
import type {
  RequestDecision,
  RunId,
  SessionEventDraft,
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
import {
  executeSubagentInBand,
  SubagentDurabilityError,
} from '@tools/delegation/inBandSubagentRun';
import { generateRunId, generateShortId } from '@utils/core';

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
const delegateReview = (
  parent: Parent,
  options: {
    stopAfterCycle?: boolean;
    userInstruction?: string;
    prompt?: string;
  } = {},
) =>
  agentTool()
    .call({ agentName: 'review', prompt: options.prompt ?? 'Check the proof.' })
    .pipe(
      Effect.provide(
        nativeToolTestLayer({
          // The child's run id derives from the call's id.
          callId: `call-${generateShortId()}`,
          ...(options.userInstruction !== undefined && {
            origin: { instruction: options.userInstruction },
          }),
          run: {
            runId: parent.runId,
            session: parent.session,
            config: AgentConfigSchema.parse({
              agent: 'assistant',
              model: MODEL,
            }),
            model: testModelCell(MODEL),
            toolPolicy: { stopAfterCycle: options.stopAfterCycle ?? false },
          },
        }),
      ),
    );

/** The in-band path a script's awaited `agent()` takes. */
const runInBand = (
  parent: Parent,
  instruction = 'Check the proof.',
  runId: RunId = generateRunId(),
) =>
  executeSubagentInBand({
    runId,
    configPayload: { agent: 'review', model: MODEL, instruction },
    parentRunId: parent.runId,
    session: parent.session,
    parentOffered: [],
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

/** Wait for `parent`'s child to commit `type`, and answer that child. */
const untilChildRow = (parent: Parent, type: string) =>
  Effect.gen(function* () {
    yield* untilStored(parent.storage, (rows) =>
      rows.some(
        (row) => row.type === type && childrenOf(parent).includes(row.run),
      ),
    );
    // cast: a child's stored id is the run id it was launched under.
    return childrenOf(parent)[0]! as RunId;
  });

/** The config a child was launched with, from its `run.config` row. */
const childConfig = (parent: Parent, child: string) =>
  rowOf(parent.storage, child, 'run.config')?.config as Record<string, string>;

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

/**
 * Run `launch`, whose child's instruction is {@link PARKED}, so that child
 * fails mid-turn: once its model call is held, its response row and then
 * `alsoFail`'s batch are refused by the store, and the call is released.
 */
const failingChild = <A, E, R>(
  parent: Parent,
  launch: Effect.Effect<A, E, R>,
  alsoFail?: SessionEventDraft['type'],
) =>
  Effect.gen(function* () {
    const faults = yield* sessionStoreFaults(parent.storage);
    const running = yield* Effect.forkChild(launch);
    yield* untilAttempt(parent);
    yield* faults.failNext('appendAll', 'model.message');
    if (alsoFail) yield* faults.failNext('appendAll', alsoFail);
    yield* releasePark(parent);
    return yield* Fiber.join(running);
  });

/** The error a {@link failingChild}'s child fails with. */
const CHILD_FAULT = 'injected appendAll fault (model.message)';

/** Release the validation model's GOLDEN-PARK hold. */
const releasePark = (parent: Parent) =>
  Effect.sync(() =>
    writeFileSync(join(parent.storage, 'golden-park.release'), ''),
  );

describe('headless delegation', { timeout: REAL_RUN_TIMEOUT }, () => {
  validationHost('texra-delegation-');

  it.live('awaits child delegation during one-shot tool-use runs', () =>
    Effect.gen(function* () {
      const parent = yield* parkedParent();
      const result = yield* delegateReview(parent, { stopAfterCycle: true });

      expect(result.summary).toBe("Completed 'review'");
      expect(result.output).toContain('<subagent-result');
      expect(result.output).toContain('<response>');
      const [child] = childrenOf(parent);
      expect(childConfig(parent, child!)).toMatchObject({
        agent: 'review',
        model: MODEL,
        instruction: expect.stringContaining('Check the proof.'),
      });
      // The child answered, and the call returned that answer.
      expect(result.output).toContain(
        (
          rowOf(parent.storage, child!, 'run.result')?.result as {
            output: { response: string };
          }
        ).output.response,
      );
    }),
  );

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
        const running = yield* Effect.forkChild(
          runInBand(parent, 'Check the proof.', runId),
        );
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
        expect(result.result).toMatchObject({
          outcome: 'completed',
          output: { files: [] },
        });
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

  it.live('persists a failed durable in-band child result', () =>
    Effect.gen(function* () {
      const parent = yield* parkedParent();
      const error = yield* Effect.flip(
        failingChild(parent, runInBand(parent, PARKED)),
      );
      expect(error).not.toBeInstanceOf(SubagentDurabilityError);
      expect(error.message).toContain(CHILD_FAULT);
      const [child] = childrenOf(parent);
      expect(rowOf(parent.storage, child!, 'run.result')).toMatchObject({
        result: { producer: 'subagent' },
      });
      expect(rowOf(parent.storage, child!, 'run.end')).toMatchObject({
        outcome: 'failed',
      });
    }),
  );

  it.live(
    'does not return a typed result when its durable manifest cannot be written',
    () =>
      Effect.gen(function* () {
        const parent = yield* parkedParent();
        const faults = yield* sessionStoreFaults(parent.storage);
        yield* faults.failNext('appendAll', 'run.result');

        expect(yield* Effect.flip(runInBand(parent))).toBeInstanceOf(
          SubagentDurabilityError,
        );
      }),
  );

  it.live(
    'preserves the child failure when its failure manifest cannot be written',
    () =>
      Effect.gen(function* () {
        const parent = yield* parkedParent();
        expect(
          yield* Effect.flip(
            failingChild(parent, runInBand(parent, PARKED), 'run.result'),
          ),
        ).toMatchObject({
          name: 'SubagentDurabilityError',
          // The child's own failure, not the manifest write's.
          message: expect.stringContaining(CHILD_FAULT),
          cause: expect.objectContaining({ name: 'AggregateError' }),
        });
      }),
  );

  it.live(
    'interrupts the live child when the in-band caller is interrupted',
    () =>
      Effect.gen(function* () {
        const parent = yield* parkedParent();
        yield* Effect.addFinalizer(() => releasePark(parent));
        const runId = generateRunId();
        // The validation model holds the child's model call.
        const running = yield* Effect.forkChild(
          runInBand(parent, PARKED, runId),
        );
        yield* untilAttempt(parent);

        // Interruption stops the child by run id and waits for it to settle
        // its own terminal record.
        yield* Fiber.interrupt(running);
        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        expect(parent.session.runs.get(runId)?.live === true).toBe(false);
        expect(rowOf(parent.storage, runId, 'run.end')).toMatchObject({
          outcome: 'cancelled',
        });
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

        const running = yield* Effect.forkChild(
          runInBand(parent, 'Check the proof.', runId),
        );
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
    'does not register a child when the in-band caller is interrupted before it starts',
    () =>
      Effect.gen(function* () {
        const parent = yield* parkedParent();
        // A child fiber is scheduled, not started, so this interrupt lands first.
        const running = yield* Effect.forkChild(runInBand(parent));
        yield* Fiber.interrupt(running);

        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        expect(childrenOf(parent)).toEqual([]);
      }),
  );

  it.live(
    'launches the validated agent source with injected handoff guidance',
    () =>
      Effect.gen(function* () {
        // The delegation must hand the resolved entry's source to the launch,
        // so the exact (source, name) key resolves instead of the ambiguous
        // bare name; and it injects handoff guidance rather than handing the
        // caller's instruction through verbatim (#5864). Wording-free: the
        // injected copy churns (#9568) without behavior changing.
        const parent = yield* parkedParent();
        yield* delegateReview(parent);
        const child = yield* untilChildRow(parent, 'run.config');

        const config = childConfig(parent, child);
        expect(config.agentSource).toBe('builtIn');
        expect(config.instruction).toContain('Check the proof.');
        expect(config.instruction!.length).toBeGreaterThan(
          'Check the proof.'.length,
        );
      }),
  );

  it.live(
    'carries the current parent instruction into the subagent constraint context',
    () =>
      Effect.gen(function* () {
        const parent = yield* parkedParent();
        const parentInstruction =
          'Do not use plans, todos, files, bash, Wolfram, or other child tools. Delegate exactly once.';
        yield* delegateReview(parent, { userInstruction: parentInstruction });
        const child = yield* untilChildRow(parent, 'run.config');

        expect(childConfig(parent, child)).toMatchObject({
          rootUserInstruction: parentInstruction,
          instruction: expect.stringContaining(
            `Parent user request (constraint context only):\n${parentInstruction}`,
          ),
        });
      }),
  );

  it.live('formats returned child error results as subagent errors', () =>
    Effect.gen(function* () {
      const parent = yield* parkedParent();
      const result = yield* failingChild(
        parent,
        delegateReview(parent, { stopAfterCycle: true, prompt: PARKED }),
      );

      expect(result.summary).toBe("'review' failed");
      expect(result.status).toBe('error');
      expect(result.error).toContain(CHILD_FAULT);
      const [child] = childrenOf(parent);
      expect(rowOf(parent.storage, child!, 'run.result')).toMatchObject({
        result: { producer: 'subagent' },
      });
    }),
  );

  it.live('does not attribute proposal cancellation to the user', () =>
    Effect.gen(function* () {
      const parent = yield* parkedParent(false);
      yield* answerOpenedRequests(parent.session, {
        action: 'cancel',
        cause: 'CLI approval prompt failed.',
      });

      const result = yield* delegateReview(parent);

      expect(result.summary).toBe("Delegation approval cancelled for 'review'");
      expect(result.error).toContain('CLI approval prompt failed.');
      expect(result.error).not.toContain('User feedback:');
      expect(childrenOf(parent)).toEqual([]);
    }),
  );

  it.live(
    'proceeds without a proposal when the run cannot present approval prompts',
    () =>
      Effect.gen(function* () {
        // Headless `--approval-policy never` withholds `requiresApproval`
        // tools up front, so a delegation tool that still executes was
        // deliberately offered (a script's `agent` calls). The proposal gate
        // must not settle a guaranteed denial; the child stays on inherited
        // approval state.
        const parent = yield* parkedParent(false);
        yield* parent.session.interactions.use({
          approvalPromptsUnavailable: true,
        });
        const opened = yield* answerOpenedRequests(parent.session, {
          action: 'approve',
        });

        const result = yield* delegateReview(parent);
        yield* untilChildRow(parent, 'run.config');

        expect(opened).toEqual([]);
        expect(result.status).toBe('executed');
        expect(result.summary).toBe("Launched 'review' (async)");
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
        expect(result.summary).toBe("Delegation denied for 'review'");
        expect(childrenOf(parent)).toEqual([]);
      }),
  );

  it.live('approves a proposal under the yolo policy without asking', () =>
    Effect.gen(function* () {
      const parent = yield* parkedParent(false);
      setTestApprovalPolicy('yolo');
      const opened = yield* answerOpenedRequests(parent.session, {
        action: 'approve',
      });

      const result = yield* delegateReview(parent);

      expect(opened).toEqual([]);
      expect(result.status).toBe('executed');
    }),
  );

  it.live(
    'rejects an approved model override unavailable in the active API mode',
    () =>
      Effect.gen(function* () {
        // The host holds no Anthropic key, so the override must be refused
        // as the initial delegation's availability gate would refuse it.
        const parent = yield* parkedParent(false);
        yield* answerOpenedRequests(parent.session, {
          action: 'approve',
          model: 'anthropic/claude-opus-5-5',
        });

        const result = yield* delegateReview(parent);

        expect(result.status).toBe('error');
        expect(result.summary).toBe(
          "Approved model override 'anthropic/claude-opus-5-5' is not available",
        );
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
        yield* agentTool()
          .call({ agentName: 'review', prompt: PARKED })
          .pipe(
            Effect.provide(
              nativeToolTestLayer({
                callId: `call-${generateShortId()}`,
                run: {
                  runId: parent.runId,
                  session: parent.session,
                  toolPolicy: {},
                },
              }),
            ),
          );
        const child = yield* untilAttempt(parent);
        const registry = registryOf(parent.session.runs);
        yield* registry['detachActiveChildren'](parent.runId);
        yield* releasePark(parent);

        yield* untilStored(parent.storage, (rows) =>
          rows.some((row) => row.run === child && row.type === 'run.report'),
        );
        expect(registry.parentOf(child)).toBeNull();
        expect(yield* queuedFollowUps(parent.session, parent.runId)).toEqual(
          [],
        );
      }),
  );
});
