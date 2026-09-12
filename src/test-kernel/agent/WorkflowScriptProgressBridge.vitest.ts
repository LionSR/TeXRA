import '@test/support/defaultSessionTestSetup';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { it } from '@effect/vitest';
import { beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import { currentSession } from '@agent/runtime/SessionHandle';
import { TraceEmitter, type AgentEvent } from '@agent/trace';
import { runPersistedWorkflowScript } from '@agent/workflowScript/checkpoint';
import { WorkflowRunAbortError } from '@agent/workflowScript/runWorkflowScript';
import type {
  WorkflowAgentInvocation,
  WorkflowScriptControl,
  WorkflowScriptRunResult,
} from '@agent/workflowScript/types';
import {
  RUN_OUTCOME,
  type RunId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { projectWorkflowScriptProgress } from '@tools/delegation/workflowScriptRun';

const meta = `export const meta = {
  name: 'progress-test',
  description: 'tests workflow progress projection',
}`;

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

/** The run every checkpoint in this file hangs under; it has to exist before
 *  a script row can name it as the aggregate's parent. */
let parentRunId: RunId;
beforeAll(async () => {
  parentRunId = publishTestRunStart(currentSession());
  await currentSession().settlePublications();
});

function recordingTrace(): {
  readonly trace: TraceEmitter;
  readonly events: AgentEvent[];
} {
  const trace = new TraceEmitter();
  const events: AgentEvent[] = [];
  trace.subscribe((event) => events.push(event));
  return { trace, events };
}

function stageId(events: readonly AgentEvent[], label: string): string {
  const event = events.find(
    (candidate) =>
      candidate.type === 'stage.start' && candidate.label === label,
  );
  if (event?.type !== 'stage.start') throw new Error(`Missing stage: ${label}`);
  return event.id;
}

function workflowCallEvent(
  events: readonly AgentEvent[],
  label: string,
  status: WorkflowCallProgress['status'],
): Extract<AgentEvent, { type: 'workflow.call' }> | undefined {
  return events.find(
    (event): event is Extract<AgentEvent, { type: 'workflow.call' }> =>
      event.type === 'workflow.call' &&
      event.call.label === label &&
      event.call.status === status,
  );
}

type ScriptRunOptions = Parameters<
  typeof projectWorkflowScriptProgress<never>
>[1];

const LIFECYCLE_STATUSES = ['queued', 'running', 'completed'] as const;

/**
 * Project a run onto `trace` and run it against this file's session, the way
 * the workflow-script strategy composes the two: the projection owns the
 * engine's event and transition slots, and settles once the run has ended
 * either way.
 */
function runScript(
  trace: TraceEmitter,
  checkpointId: string,
  script: string,
  options: Partial<Omit<ScriptRunOptions, 'session' | 'parentRunId'>> = {},
): Effect.Effect<WorkflowScriptRunResult, Error> {
  return runProjected(trace, {
    checkpointId,
    script,
    runAgent: () =>
      Effect.sync(function () {
        return 'done';
      }),
    ...options,
  });
}

/** Run one projection over the file's session; the resume paths' entry. */
function runProjected(
  trace: TraceEmitter,
  options: Omit<ScriptRunOptions, 'session' | 'parentRunId'>,
): Effect.Effect<WorkflowScriptRunResult, Error> {
  const projection = projectWorkflowScriptProgress(trace, {
    session: currentSession(),
    parentRunId,
    ...options,
  });
  return runPersistedWorkflowScript(projection.options).pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        projection.settle(Exit.isSuccess(exit));
      }),
    ),
  );
}

/** Collects activity-line strings reported through `onActivity`. */
function collectActivities(): {
  readonly activities: string[];
  readonly onActivity: (line: string) => void;
} {
  const activities: string[] = [];
  return { activities, onActivity: (line) => activities.push(line) };
}

/**
 * The current card set, one entry per `logId` — what a host progress tree
 * holds after applying every update.
 */
/**
 * The current card set, one entry per `logId` — what a host progress tree
 * holds after applying every update.
 */
function latestWorkflowCallEvents(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { type: 'workflow.call' }>[] {
  const byLogId = new Map<
    string,
    Extract<AgentEvent, { type: 'workflow.call' }>
  >();
  for (const event of events) {
    if (event.type === 'workflow.call') byLogId.set(event.logId, event);
  }
  return [...byLogId.values()];
}

describe('workflow-script progress bridge', () => {
  it.live('records the declared plan once, before any phase opens', () =>
    Effect.gen(function* () {
      const { trace, events } = recordingTrace();
      yield* runScript(
        trace,
        'plan-marker',
        `export const meta = {
  name: 'plan-marker-test',
  description: 'records the declared plan',
  phases: [{ title: 'Research' }, { title: 'Write' }],
  tasks: [
    { id: 'inspect', label: 'Inspect source', phase: 'Research' },
    { id: 'draft', label: 'Draft the section', phase: 'Write' },
  ],
}
phase('Research')
return await agent('Inspect', { id: 'inspect' })`,
      );

      const plans = events.filter((event) => event.type === 'workflow.plan');
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({
        attemptId: expect.any(String),
        phases: [{ title: 'Research' }, { title: 'Write' }],
        tasks: [
          { id: 'inspect', label: 'Inspect source', phase: 'Research' },
          { id: 'draft', label: 'Draft the section', phase: 'Write' },
        ],
      });
      // The plan precedes the first phase stage and every card.
      const planIndex = events.indexOf(plans[0]!);
      const firstStage = events.findIndex(
        (event) => event.type === 'stage.start',
      );
      const firstCard = events.findIndex(
        (event) => event.type === 'workflow.call',
      );
      expect(planIndex).toBeLessThan(firstStage);
      expect(planIndex).toBeLessThan(firstCard);
    }),
  );

  it.live(
    'keeps planned call cards in their phase stage across incremental updates',
    () =>
      Effect.gen(function* () {
        const { trace, events } = recordingTrace();
        const parent = trace.openStage('Parent');
        const plannedMeta = `export const meta = {
  name: 'planned-progress-test',
  description: 'tests planned workflow progress projection',
  phases: [{ title: 'Research' }, { title: 'Write' }],
  tasks: [{ id: 'inspect', label: 'Inspect source', phase: 'Research' }],
}`;

        const projected = yield* Effect.promise(() =>
          parent.within(() =>
            runScript(
              trace,
              'phase-log',
              `${plannedMeta}
log('Preparing the workflow')
phase('Research')
log('Checking the source')
return await agent('Inspect', { id: 'inspect' })`,
            ),
          ),
        );
        yield* projected;

        const phaseId = stageId(events, 'Research');
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'log',
            message: 'Preparing the workflow',
            stageId: parent.id,
          }),
        );
        const queued = workflowCallEvent(events, 'Inspect source', 'queued');
        const running = workflowCallEvent(events, 'Inspect source', 'running');
        const completed = workflowCallEvent(
          events,
          'Inspect source',
          'completed',
        );
        // One stable, phase-derived stage across the whole lifecycle: the card is
        // classified into its phase group when it is queued and never moves.
        expect(queued).toMatchObject({
          type: 'workflow.call',
          stageId: phaseId,
          call: { attemptId: expect.any(String) },
        });
        expect(running).toMatchObject({
          type: 'workflow.call',
          logId: queued?.logId,
          stageId: phaseId,
          call: { attemptId: queued?.call.attemptId },
        });
        expect(completed).toMatchObject({
          type: 'workflow.call',
          logId: queued?.logId,
          stageId: phaseId,
          call: { attemptId: queued?.call.attemptId },
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'stage.start',
            id: phaseId,
            parentId: parent.id,
            kind: 'phase',
            index: 0,
            total: 2,
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'log',
            message: 'Checking the source',
            stageId: phaseId,
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'stage.end',
            id: phaseId,
            status: RUN_OUTCOME.COMPLETED,
          }),
        );
      }),
  );

  it.live(
    'separates declared plan labels from the calls the script issues',
    () =>
      Effect.gen(function* () {
        const { trace, events } = recordingTrace();
        yield* runScript(
          trace,
          'declared-vs-issued',
          `export const meta = {
  name: 'declared-vs-issued',
  description: 'one declared item, one structured call, one document call',
  phases: [{ title: 'Investigate' }, { title: 'Revise' }],
  tasks: [
    { id: 'claims', label: 'Extract claims', phase: 'Investigate' },
    { id: 'intro', label: 'Rewrite introduction', phase: 'Revise' },
    { id: 'never', label: 'Never issued', phase: 'Revise' },
  ],
}
phase('Investigate')
await agent('Extract', {
  id: 'claims',
  agentName: 'researcher',
  model: 'gpt56',
  schema: { type: 'object', properties: { claims: { type: 'array' } } },
})
phase('Revise')
return await agent('Rewrite', {
  id: 'intro',
  agentName: 'polish',
  inputFiles: ['paper/introduction.tex'],
  contextFiles: ['paper/main.tex'],
})`,
          {
            fingerprintAgentDependencies: () =>
              Effect.sync(function () {
                return 'fingerprint';
              }),
            runAgent: (invocation: WorkflowAgentInvocation) =>
              Effect.sync(function () {
                invocation.report({
                  agent: invocation.options.agentName,
                  model: invocation.options.model ?? 'gemini37f',
                });
                return 'done';
              }),
          },
        );

        // A plan label carries no invocation facts until the script issues it…
        const declared = workflowCallEvent(
          events,
          'Extract claims',
          'declared',
        );
        expect(declared?.call).not.toHaveProperty('kind');
        expect(declared?.call).not.toHaveProperty('files');
        // …and the issued call reports its real contract, agent, model, and files.
        expect(
          workflowCallEvent(events, 'Extract claims', 'queued')?.call,
        ).toMatchObject({
          kind: 'structured',
          agent: 'researcher',
          model: 'gpt56',
          files: { input: [], context: [], media: [] },
        });
        // The host-resolved model lands on the card once the runner reports it.
        expect(
          latestWorkflowCallEvents(events).find(
            (event) => event.call.label === 'Rewrite introduction',
          )?.call,
        ).toMatchObject({
          status: 'completed',
          kind: 'document',
          agent: 'polish',
          model: 'gemini37f',
          files: {
            input: ['introduction.tex'],
            context: ['main.tex'],
            media: [],
          },
        });
        // The never-issued label ends as not-reached and stays a bare label.
        const unreached = workflowCallEvent(events, 'Never issued', 'skipped');
        expect(unreached?.call).toMatchObject({ reason: 'not-reached' });
        expect(unreached?.call).not.toHaveProperty('kind');
      }),
  );

  it.live('marks declared tasks not reached by the script as skipped', () =>
    Effect.gen(function* () {
      const { trace, events } = recordingTrace();
      const { activities, onActivity } = collectActivities();
      yield* runScript(
        trace,
        'not-reached-plan',
        `export const meta = {
  name: 'conditional-plan',
  description: 'declares all possible work',
  phases: [{ title: 'Research' }],
  tasks: [
    { id: 'used', label: 'Used task', phase: 'Research' },
    { id: 'unused', label: 'Unused task', phase: 'Research' },
  ],
}
phase('Research')
return await agent('Run one', { id: 'used' })`,
        { onActivity },
      );

      const unusedPlanned = workflowCallEvent(
        events,
        'Unused task',
        'declared',
      );
      expect(workflowCallEvent(events, 'Used task', 'completed')).toBeDefined();
      expect(workflowCallEvent(events, 'Unused task', 'skipped')).toMatchObject(
        {
          logId: unusedPlanned?.logId,
          stageId: unusedPlanned?.stageId,
          call: {
            reason: 'not-reached',
          },
        },
      );
      expect(activities).toContain(
        'Skipped: Unused task — The workflow ended before this call was reached.',
      );
    }),
  );

  it.live('opens and closes a declared phase the run never reached', () =>
    Effect.gen(function* () {
      const { trace, events } = recordingTrace();
      yield* runScript(
        trace,
        'unreached-phase',
        `export const meta = {
  name: 'unreached-phase',
  description: 'declares a phase the run never enters',
  phases: [{ title: 'Research' }, { title: 'Write' }],
  tasks: [
    { id: 'used', label: 'Used task', phase: 'Research' },
    { id: 'later', label: 'Later task', phase: 'Write' },
  ],
}
phase('Research')
return await agent('Run one', { id: 'used' })`,
      );

      // The skipped card still belongs to its own phase group, so the sweep has
      // to open that stage even though the script never entered it.
      const writeId = stageId(events, 'Write');
      expect(workflowCallEvent(events, 'Later task', 'skipped')).toMatchObject({
        stageId: writeId,
        call: { reason: 'not-reached' },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'stage.start',
          id: writeId,
          kind: 'phase',
        }),
      );
      expect(events).toContainEqual({
        type: 'stage.end',
        id: writeId,
        status: RUN_OUTCOME.COMPLETED,
      });
    }),
  );

  it.live(
    'keeps a phase-less declared task out of the phase active at call time',
    () =>
      Effect.gen(function* () {
        const { trace, events } = recordingTrace();
        yield* runScript(
          trace,
          'phase-less-declared-task',
          `export const meta = {
  name: 'phase-less-declared-task',
  description: 'declares a task with no phase',
  phases: [{ title: 'Research' }],
  tasks: [{ id: 'loose', label: 'Loose task' }],
}
phase('Research')
return await agent('Run loose', { id: 'loose' })`,
        );

        // meta.tasks[].phase is optional, so the plan can declare a task with no
        // phase while a phase() is active. Its card must stay where it was first
        // classified — a progress tree cannot move a card between groups — and the
        // payload every host folds `done/total` by must say the same thing, so a
        // phase-less task is counted under no phase rather than under the wrong one.
        for (const status of LIFECYCLE_STATUSES) {
          const event = workflowCallEvent(events, 'Loose task', status);
          expect(event).toMatchObject({ stageId: undefined });
          expect(event?.call.phase).toBeUndefined();
        }

        // The two answers agree by construction: the phase whose group holds the
        // card and the phase the shared fold reads off the payload are the same
        // recorded value. Under the active phase both are empty.
        const researchId = stageId(events, 'Research');
        const latest = latestWorkflowCallEvents(events);
        expect(
          latest.filter((event) => event.call.phase === 'Research'),
        ).toHaveLength(0);
        expect(
          latest.filter((event) => event.stageId === researchId),
        ).toHaveLength(0);
      }),
  );

  it.live(
    'does not fail an active phase for a failed phase-less declared task',
    () =>
      Effect.gen(function* () {
        const { trace, events } = recordingTrace();
        yield* runScript(
          trace,
          'failed-phase-less-declared-task',
          `export const meta = {
  name: 'failed-phase-less-declared-task',
  description: 'keeps a phase-less failure outside the active phase',
  phases: [{ title: 'Research' }],
  tasks: [{ id: 'loose', label: 'Loose task' }],
}
phase('Research')
return await agent('Run loose', { id: 'loose' })`,
          {
            runAgent: () =>
              Effect.sync(function () {
                throw new Error('model unavailable');
              }),
          },
        );

        const researchId = stageId(events, 'Research');
        const failed = workflowCallEvent(events, 'Loose task', 'failed');
        expect(failed).toMatchObject({
          stageId: undefined,
          call: { error: 'model unavailable' },
        });
        expect(failed?.call.phase).toBeUndefined();
        expect(events).toContainEqual({
          type: 'stage.end',
          id: researchId,
          status: RUN_OUTCOME.COMPLETED,
        });
      }),
  );

  it.live('marks a planned task failed when the live-call cap refuses it', () =>
    Effect.gen(function* () {
      const { trace, events } = recordingTrace();
      expect(
        yield* Effect.flip(
          runScript(
            trace,
            'planned-call-cap',
            `export const meta = {
  name: 'planned-call-cap',
  description: 'distinguishes refused work from work not reached',
  phases: [{ title: 'Audit' }],
  tasks: [
    { id: 'first', label: 'First audit', phase: 'Audit' },
    { id: 'refused', label: 'Refused audit', phase: 'Audit' },
  ],
}
await agent('Run first', { id: 'first' })
return await agent('Run refused', { id: 'refused' })`,
            { maxAgentCalls: 1 },
          ),
        ),
      ).toMatchObject({ message: expect.stringMatching(/agent-call cap/) });

      expect(
        workflowCallEvent(events, 'Refused audit', 'failed'),
      ).toMatchObject({
        call: {
          error: expect.stringContaining('agent-call cap'),
        },
      });
      expect(
        workflowCallEvent(events, 'Refused audit', 'skipped'),
      ).toBeUndefined();
    }),
  );

  it.live('rejects duplicate dynamic logical call ids', () =>
    Effect.gen(function* () {
      const { trace } = recordingTrace();
      expect(
        yield* Effect.flip(
          runScript(
            trace,
            'duplicate-logical-id',
            `${meta}
return await parallel([
  () => agent('First prompt', { id: 'shared-journal-id' }),
  () => agent('Second prompt', { id: 'shared-journal-id' }),
])`,
          ),
        ),
      ).toMatchObject({
        message: expect.stringMatching(
          /call id "shared-journal-id" may be issued only once/i,
        ),
      });
    }),
  );

  it.live(
    'projects a cached completion without synthesizing a start event',
    () =>
      Effect.gen(function* () {
        const script = `${meta}
return await agent('Read', { phase: 'Review' })`;
        yield* runScript(recordingTrace().trace, 'cached', script, {
          runAgent: () =>
            Effect.sync(function () {
              return 'saved';
            }),
        });

        const { trace, events } = recordingTrace();
        const runner = vi.fn(() => Effect.fail(new Error('must not run')));
        yield* runProjected(trace, {
          checkpointId: 'cached',
          runAgent: runner,
        });

        const phaseId = stageId(events, 'Review');
        expect(runner).not.toHaveBeenCalled();
        expect(workflowCallEvent(events, 'Read', 'cached')).toMatchObject({
          type: 'workflow.call',
          stageId: phaseId,
        });
        expect(workflowCallEvent(events, 'Read', 'running')).toBeUndefined();
      }),
  );

  it.live('re-emits a cached card on a second durable resume', () =>
    Effect.gen(function* () {
      const script = `${meta}
phase('Review')
return await agent('Read', { id: 'read' })`;
      const first = yield* runScript(
        recordingTrace().trace,
        'twice-resumed',
        script,
        {
          runAgent: () =>
            Effect.sync(function () {
              return 'saved';
            }),
        },
      );

      const runner = vi.fn(() => Effect.fail(new Error('must not run')));
      const second = yield* runProjected(recordingTrace().trace, {
        checkpointId: 'twice-resumed',
        runAgent: runner,
        initialSnapshot: first.snapshot,
      });
      expect(second.snapshot.calls[0]?.status).toBe('cached');

      // The second resume hydrates an already-cached call. Re-issuing it must
      // still project a card: a host that starts watching here would otherwise
      // never see the call at all.
      const { trace, events } = recordingTrace();
      yield* runProjected(trace, {
        checkpointId: 'twice-resumed',
        runAgent: runner,
        initialSnapshot: second.snapshot,
      });

      expect(runner).not.toHaveBeenCalled();
      expect(workflowCallEvent(events, 'Read', 'cached')).toMatchObject({
        type: 'workflow.call',
        stageId: stageId(events, 'Review'),
      });
    }),
  );

  it.live(
    'reissues hydrated calls when hydration and issue share a timestamp',
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-08-15T20:00:00.000Z'));
        try {
          const script = `${meta}
phase('Review')
return await agent('Retry review', { id: 'retry-review' })`;
          const failed = yield* runScript(
            recordingTrace().trace,
            'failed-hydrated-call',
            script,
            {
              runAgent: vi.fn(() =>
                Effect.fail(new Error('first attempt failed')),
              ),
            },
          );
          expect(failed.snapshot.calls[0]?.status).toBe('failed');

          const retry = recordingTrace();
          // Keep the exact same millisecond for constructor hydration and
          // issueCall: projection admission must use the explicit issue fact.
          yield* runScript(retry.trace, 'failed-hydrated-call', script);

          const reviewId = stageId(retry.events, 'Review');
          expect(
            workflowCallEvent(retry.events, 'Retry review', 'queued'),
          ).toMatchObject({ stageId: reviewId, call: { phase: 'Review' } });
          expect(
            workflowCallEvent(retry.events, 'Retry review', 'completed'),
          ).toMatchObject({ stageId: reviewId, call: { phase: 'Review' } });
        } finally {
          vi.useRealTimers();
        }
      }),
  );

  it.live('does not project a failed hydrated call omitted by the retry', () =>
    Effect.gen(function* () {
      const failed = yield* runScript(
        recordingTrace().trace,
        'omitted-hydrated-call',
        `${meta}
return await agent('Historical call', { id: 'historical' })`,
        { runAgent: vi.fn(() => Effect.fail(new Error('failed'))) },
      );
      expect(failed.snapshot.calls[0]?.status).toBe('failed');

      const retry = recordingTrace();
      yield* runScript(
        retry.trace,
        'omitted-hydrated-call',
        `${meta}
return 'done'`,
      );

      expect(retry.events.some((event) => event.type === 'workflow.call')).toBe(
        false,
      );

      // The same omission when the prior snapshot is hydrated too: the dropped
      // call is reset to `declared`, then the settle sweep terminalizes it to
      // not-reached. That sweep is bookkeeping for the previous attempt, so it
      // must stay out of this attempt's cards.
      const hydrated = recordingTrace();
      const resumed = yield* runScript(
        hydrated.trace,
        'omitted-hydrated-call-resumed',
        `${meta}
return 'done'`,
        { initialSnapshot: failed.snapshot },
      );
      expect(
        resumed.snapshot.calls.map((call) => [call.id, call.status]),
      ).toEqual([['historical', 'skipped']]);
      expect(
        hydrated.events.some((event) => event.type === 'workflow.call'),
      ).toBe(false);
    }),
  );

  it.live(
    'keeps phase counts when an agent opens the stage before phase()',
    () =>
      Effect.gen(function* () {
        const { trace, events } = recordingTrace();
        const script = `export const meta = {
  name: 'early-phase-agent',
  description: 'opens a declared phase from an agent event',
  phases: [{ title: 'Research' }, { title: 'Write' }],
}
const early = agent('Draft', { phase: 'Write' })
phase('Write')
return await early`;

        yield* runScript(trace, 'early-phase-agent', script);

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'stage.start',
            id: stageId(events, 'Write'),
            kind: 'phase',
            index: 1,
            total: 2,
          }),
        );
      }),
  );

  it.live(
    'projects trimmed runtime and declared task phases onto one stage',
    () =>
      Effect.gen(function* () {
        const { trace, events } = recordingTrace();
        const script = `export const meta = {
  name: 'trimmed-declared-task-phase',
  description: 'keeps task and runtime phase identity canonical',
  phases: [{ title: '  Review  ' }],
  tasks: [{
    id: 'review-task',
    label: '  Review argument  ',
    phase: '  Review  ',
  }],
}
phase('  Review  ')
return await agent('Review the argument', { id: 'review-task' })`;

        yield* runScript(trace, 'trimmed-declared-task-phase', script);

        const phaseStarts = events.filter(
          (event) => event.type === 'stage.start' && event.kind === 'phase',
        );
        expect(phaseStarts).toEqual([
          expect.objectContaining({
            label: 'Review',
            index: 0,
            total: 1,
          }),
        ]);
        const queued = workflowCallEvent(events, 'Review argument', 'queued');
        for (const status of LIFECYCLE_STATUSES) {
          expect(
            workflowCallEvent(events, 'Review argument', status),
          ).toMatchObject({
            logId: queued?.logId,
            call: {
              id: 'review-task',
              label: 'Review argument',
              phase: 'Review',
              status,
            },
          });
        }
      }),
  );

  it.live('renders each call cost on live finish lines only', () =>
    Effect.gen(function* () {
      const script = `${meta}
await agent('First')
return await agent('Second')`;
      const { trace, events } = recordingTrace();
      // The runner reports spend the way production does; the engine folds it
      // into the run snapshot and stamps it on the terminal event.
      yield* runScript(trace, 'live-cost', script, {
        runAgent: (invocation: WorkflowAgentInvocation) =>
          Effect.sync(function () {
            invocation.report({ costUsd: 0.05 });
            return 'done';
          }),
      });

      expect(
        workflowCallEvent(events, 'First', 'completed')?.call,
      ).toMatchObject({
        costUsd: 0.05,
      });
      expect(
        workflowCallEvent(events, 'Second', 'completed')?.call,
      ).toMatchObject({
        costUsd: 0.05,
      });

      const replay = recordingTrace();
      yield* runScript(replay.trace, 'live-cost', script, {
        runAgent: vi.fn(() => Effect.fail(new Error('must not run'))),
      });

      expect(
        workflowCallEvent(replay.events, 'First', 'cached')?.call,
      ).not.toHaveProperty('costUsd');
    }),
  );

  it.live(
    'enriches live finish lines with the reported model and duration',
    () =>
      Effect.gen(function* () {
        const { trace, events } = recordingTrace();
        const { activities, onActivity } = collectActivities();
        yield* runScript(
          trace,
          'model-duration',
          `${meta}
return await agent('Draft')`,
          {
            runAgent: (invocation: WorkflowAgentInvocation) =>
              Effect.sync(function () {
                invocation.report({ model: 'deepseekT' });
                invocation.report({
                  childRunId: 'draft@deepseekT#abcdef' as RunId,
                });
                invocation.report({ costUsd: 0.02 });
                return 'done';
              }),
            onActivity,
          },
        );

        expect(
          workflowCallEvent(events, 'Draft', 'completed')?.call,
        ).toMatchObject({
          model: 'deepseekT',
          childRunId: 'draft@deepseekT#abcdef',
          durationMs: expect.any(Number),
          costUsd: 0.02,
        });
        const draftEvents = events.filter(
          (event): event is Extract<AgentEvent, { type: 'workflow.call' }> =>
            event.type === 'workflow.call' && event.call.label === 'Draft',
        );
        const logIds = new Set(draftEvents.map((event) => event.logId));
        expect(logIds.size).toBe(1);
        expect([...logIds][0]).toMatch(/^workflow-task-.+-call-0$/);
        expect(activities).toContainEqual(
          expect.stringMatching(
            /^Finished: Draft · Document · deepseekT · .+ · \$0\.020$/,
          ),
        );
      }),
  );

  it.live('uses a new task-card identity for a deterministic relaunch', () =>
    Effect.gen(function* () {
      const script = `${meta}
return await agent('Draft')`;
      const first = recordingTrace();
      yield* runScript(first.trace, 'relaunch-card-id', script, {
        runAgent: vi.fn(() => Effect.succeed('done')),
      });

      const second = recordingTrace();
      yield* runScript(second.trace, 'relaunch-card-id', script, {
        runAgent: vi.fn(() => Effect.fail(new Error('must not run'))),
      });

      const firstId = workflowCallEvent(
        first.events,
        'Draft',
        'completed',
      )?.logId;
      const secondId = workflowCallEvent(
        second.events,
        'Draft',
        'cached',
      )?.logId;
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();
      expect(secondId).not.toBe(firstId);
    }),
  );

  it.live('preserves live metadata when the user skips a running call', () =>
    Effect.gen(function* () {
      const { trace, events } = recordingTrace();
      const { activities, onActivity } = collectActivities();
      let control!: WorkflowScriptControl;
      const started = yield* Deferred.make<void>();
      const run = runScript(
        trace,
        'late-user-skip',
        `${meta}
return await agent('Late skip')`,
        {
          runAgent: (invocation: WorkflowAgentInvocation) =>
            Effect.gen(function* () {
              invocation.report({
                model: 'kimiK2',
                childRunId: 'da7e5c1b' as RunId,
                costUsd: 0.04,
              });
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
          onControl: (handle) => {
            control = handle;
          },
          onActivity,
        },
      );

      const fiber = yield* run.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      control('da7e5c1b' as RunId, 'skip');
      yield* Fiber.join(fiber);

      expect(
        workflowCallEvent(events, 'Late skip', 'skipped')?.call,
      ).toMatchObject({
        reason: 'user',
        model: 'kimiK2',
        durationMs: expect.any(Number),
        costUsd: 0.04,
      });
      expect(activities).toContain('Running: Late skip');
      expect(activities).toContainEqual(
        expect.stringMatching(
          /^Skipped: Late skip · Document · kimiK2 · .+ · \$0\.040$/,
        ),
      );
    }),
  );

  it.live('marks a phase failed when an agent call fails', () =>
    Effect.gen(function* () {
      const { trace, events } = recordingTrace();
      yield* runScript(
        trace,
        'agent-failure',
        `${meta}
phase('Analysis')
return await agent('Unsuccessful')`,
        {
          runAgent: () =>
            Effect.sync(function () {
              throw new Error('model unavailable');
            }),
        },
      );

      const phaseId = stageId(events, 'Analysis');
      expect(workflowCallEvent(events, 'Unsuccessful', 'failed')).toMatchObject(
        {
          type: 'workflow.call',
          stageId: phaseId,
          call: {
            error: 'model unavailable',
          },
        },
      );
      expect(events).toContainEqual({
        type: 'stage.end',
        id: phaseId,
        status: RUN_OUTCOME.FAILED,
      });
    }),
  );

  it.live(
    'keeps out-of-order parallel completions in their starting phases',
    () =>
      Effect.gen(function* () {
        const { trace, events } = recordingTrace();
        const started = yield* Deferred.make<void>();
        const pending = new Map<string, Deferred.Deferred<string>>();
        const runAgent = vi.fn(
          Effect.fn(function* ({ prompt }: WorkflowAgentInvocation) {
            const result = yield* Deferred.make<string>();
            pending.set(prompt, result);
            if (pending.size === 2) yield* Deferred.succeed(started, undefined);
            return yield* Deferred.await(result);
          }),
        );
        const run = runScript(
          trace,
          'parallel-phases',
          `${meta}
phase('First')
const slow = agent('slow')
phase('Second')
const fast = agent('fast')
return await Promise.all([slow, fast])`,
          { runAgent },
        );

        const fiber = yield* run.pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const fast = pending.get('fast');
        const slow = pending.get('slow');
        if (!fast || !slow) throw new Error('Both calls must have started');
        yield* Deferred.succeed(fast, 'fast result');
        yield* Deferred.succeed(slow, 'slow result');
        yield* Fiber.join(fiber);

        const firstId = stageId(events, 'First');
        const secondId = stageId(events, 'Second');
        expect(workflowCallEvent(events, 'slow', 'completed')).toMatchObject({
          stageId: firstId,
        });
        expect(workflowCallEvent(events, 'fast', 'completed')).toMatchObject({
          stageId: secondId,
        });
      }),
  );

  it.live('does not move an unphased live call into a later phase', () =>
    Effect.gen(function* () {
      const { trace, events } = recordingTrace();
      yield* runScript(
        trace,
        'late-phase',
        `${meta}
const pending = agent('before phase')
phase('Later')
return await pending`,
      );

      const completion = workflowCallEvent(events, 'before phase', 'completed');
      expect(completion).toMatchObject({
        type: 'workflow.call',
        stageId: undefined,
      });
      expect(completion).not.toMatchObject({
        stageId: stageId(events, 'Later'),
      });
    }),
  );

  it.live(
    'preserves the exact cause when a runner aborts a started phase',
    () =>
      Effect.gen(function* () {
        const { trace, events } = recordingTrace();
        const { activities, onActivity } = collectActivities();
        expect(
          yield* Effect.flip(
            runScript(
              trace,
              'runner-abort',
              `${meta}
return await agent('Abort', { phase: 'Run' })`,
              {
                runAgent: (invocation: WorkflowAgentInvocation) =>
                  Effect.sync(function () {
                    invocation.report({ model: 'abort-model', costUsd: 0.06 });
                    throw new WorkflowRunAbortError('fatal runner error');
                  }),
                onActivity,
              },
            ),
          ),
        ).toMatchObject({
          message: expect.stringContaining('fatal runner error'),
        });

        const phaseId = stageId(events, 'Run');
        expect(workflowCallEvent(events, 'Abort', 'failed')).toMatchObject({
          stageId: phaseId,
          call: {
            error: 'fatal runner error',
            model: 'abort-model',
            durationMs: expect.any(Number),
            costUsd: 0.06,
          },
        });
        expect(events).toContainEqual({
          type: 'stage.end',
          id: phaseId,
          status: RUN_OUTCOME.FAILED,
        });
        expect(activities).toContainEqual(
          expect.stringMatching(
            /^Failed: Abort · Document · abort-model · .+ · \$0\.060 — fatal runner error$/,
          ),
        );
      }),
  );

  it.live('marks an abandoned call failed after interruption', () =>
    Effect.gen(function* () {
      const { trace, events } = recordingTrace();
      const { activities, onActivity } = collectActivities();
      const started = yield* Deferred.make<void>();
      const run = runScript(
        trace,
        'orphaned-runner',
        `${meta}
agent('Orphaned', { phase: 'Run' })
await agent('Confirm started')
return 'guest success'`,
        {
          runAgent: (invocation: WorkflowAgentInvocation) =>
            Effect.gen(function* () {
              if (invocation.prompt === 'Confirm started') {
                yield* Deferred.await(started);
                return 'ready';
              }
              invocation.report({
                childRunId: 'orphaned@model#abcdef' as RunId,
                costUsd: 0.03,
              });
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
          onActivity,
        },
      );

      const fiber = yield* run.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.join(fiber);

      const phaseId = stageId(events, 'Run');
      expect(workflowCallEvent(events, 'Orphaned', 'failed')).toMatchObject({
        stageId: phaseId,
        call: {
          error: 'The workflow ended before this call completed.',
          costUsd: 0.03,
          childRunId: 'orphaned@model#abcdef',
        },
      });
      expect(events).toContainEqual({
        type: 'stage.end',
        id: phaseId,
        status: RUN_OUTCOME.FAILED,
      });
      expect(activities).toContain('Running: Orphaned');
      expect(activities).toContain(
        'Failed: Orphaned · Document · $0.030 — The workflow ended before this call completed.',
      );
    }),
  );

  it.live('closes every opened phase after a script failure', () =>
    Effect.gen(function* () {
      const { trace, events } = recordingTrace();
      expect(
        yield* Effect.flip(
          runScript(
            trace,
            'script-failure',
            `${meta}
phase('One')
log('first')
phase('Two')
throw new Error('script failed')`,
          ),
        ),
      ).toMatchObject({ message: expect.stringContaining('script failed') });

      // The engine settled 'One' cleanly before the script threw inside 'Two';
      // only the phase the failure happened in reads failed.
      expect(events).toContainEqual({
        type: 'stage.end',
        id: stageId(events, 'One'),
        status: RUN_OUTCOME.COMPLETED,
      });
      expect(events).toContainEqual({
        type: 'stage.end',
        id: stageId(events, 'Two'),
        status: RUN_OUTCOME.FAILED,
      });
    }),
  );
});
