/**
 * The dispatch guarantees the loop must keep: barrier segmentation, the
 * parallel-safe concurrency window, duplicate fan-out without repeated
 * effects, the terminal-result stop, and the deliberate absence of
 * fail-fast sibling interruption. Each case runs the tool-use loop over a
 * scripted model whose first turn calls the tools; settlements are read
 * off the run history the dispatch did or did not commit to.
 */

// Third-party imports
import { Context, Deferred, Effect, Fiber, Layer } from 'effect';
import { layer } from '@effect/vitest';

import { expect } from 'vitest';

// Local imports
import { qualifyAggregateId, type RunId } from '@texra-ai/harness/schemas';
import { openToolUse, runToolUse } from '@agent/runtime/loop/runLoop';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { RunHistory, SessionLog } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runState';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  scriptedModel,
  startedRun,
  textTurn,
  toolCallTurn,
} from '@test/support/scriptedRunLayers';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';
import { ScriptTool } from '@tools/codemode/ScriptTool';
import { ExecutionsTool } from '@tools/ExecutionsTool';

import { recordSessionEvents } from '@test/agent/progressTestUtils';
import type { ITool, ToolResult } from '@texra-ai/harness/plugins';

/** The calls a folded state holds settled. */
const settledIds = (state: RunState | null | undefined): string[] =>
  Object.entries(state?.pendingResponse?.records ?? {}).flatMap(([id, call]) =>
    call.status.kind === 'settled' ? [id] : [],
  );

/** A tool as the step's registry holds it. */
type StepTool = ITool<Error, PluginToolServices>;

interface DispatchProbe {
  events: string[];
  inFlight: number;
  maxInFlight: number;
}

const newProbe = (): DispatchProbe => ({
  events: [],
  inFlight: 0,
  maxInFlight: 0,
});

/** A tool that records its start and end on `probe` and holds on `hold`
 *  between them. */
const probeTool = (
  probe: DispatchProbe,
  name: string,
  hold: Effect.Effect<void>,
  lane?: StepTool['lane'],
): StepTool => ({
  definition: { name, description: name, parameters: {} },
  lane,
  call: Effect.fn(function* (input: unknown): Effect.fn.Return<ToolResult> {
    const tag = `${name}:${JSON.stringify(input)}`;
    probe.events.push(`start ${tag}`);
    probe.inFlight += 1;
    probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
    yield* hold;
    probe.inFlight -= 1;
    probe.events.push(`end ${tag}`);
    return { status: 'executed', output: `${tag} ok` };
  }),
});

type Call = Parameters<typeof toolCallTurn>[0][number];

/**
 * A headless run of the tool-use loop whose first turn makes `calls`
 * against `tools`, and whose second ends the run.
 */
const runLoop = (
  session: Context.Context<SessionServices>,
  runId: RunId,
  tools: Record<string, StepTool>,
  calls: readonly Call[],
) =>
  Effect.flatMap(openToolUse({ resume: false }), (opened) =>
    runToolUse({ resume: false }, opened),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        scriptedInvokerLayer,
        nativeToolTestLayer({ run: { runId, session, toolPolicy: {} } }),
      ).pipe(
        Layer.provideMerge(
          agentRunTestLayer({
            runId,
            session,
            tools,
            model: scriptedModel([toolCallTurn(calls), textTurn('done')]).model,
            stopAfterCycle: true,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(RunHistory)(Context.get(session, RunHistory)),
        ),
      ),
    ),
    // The invoker's debug-object sink writes through the process `FileSystem`.
    Effect.provide(nodePlatformLayer),
  );

/** A fresh session and a started run on it. */
const openRun = Effect.gen(function* () {
  const session = yield* isolatedTestSession();
  return { session, runId: yield* startedRun(session) };
});

/** The run's tool results, in commit order. */
const committedResults = (
  session: Context.Context<SessionServices>,
  runId: RunId,
) =>
  Effect.gen(function* () {
    const log = Context.get(session, SessionLog);
    yield* log.settled;
    return (yield* log.runRows(qualifyAggregateId('run', runId), 'results'))
      .results;
  });

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'tool-use dispatch',
  (it) => {
    it.layer(FakeHost.layer({ workspaceRoot: '/workspace' }), {
      buildPerTest: true,
    })((it) => {
      // Failure modes: a SQL page reaches the guest as display text, losing its
      // typed cells and pagination; display truncation changes a data value; or
      // generated SQL values bypass the page's serialized byte limit.
      it.effect('delivers bounded SQL pages as data to a script', () =>
        Effect.gen(function* () {
          const text = `${'x'.repeat(3000)}|\nend`;
          const { session, runId } = yield* openRun;
          yield* runLoop(
            session,
            runId,
            {
              // cast: the built-ins' services are the dispatch's.
              script: ScriptTool as unknown as StepTool,
              executions: ExecutionsTool,
            },
            [
              {
                id: 'query-script',
                name: 'script',
                input: {
                  code: `const page = await tools.executions({
  path: '/executions', action: 'query',
  sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 201) SELECT x AS number, ? AS text, NULL AS absent FROM n',
  params: [${JSON.stringify(text)}],
});
let oversized = null;
try {
  await tools.executions({
    path: '/executions', action: 'query',
    sql: "SELECT replace(printf('%3000000s', ''), ' ', 'é') AS oversized",
  });
} catch (error) {
  oversized = { name: error.name, message: error.message };
}
return { columns: page.columns, count: page.rows.length,
  first: page.rows[0], last: page.rows.at(-1), more: page.more, oversized };`,
                },
              },
            ],
          );
          const results = yield* committedResults(session, runId);
          const script = results.find(
            ({ callId }) => callId === 'query-script',
          );
          expect(
            script?.result.status,
            script?.result.status === 'error' ? script.result.error : undefined,
          ).toBe('executed');
          expect(script?.result).toMatchObject({
            status: 'executed',
            value: {
              columns: ['number', 'text', 'absent'],
              count: 200,
              first: [1, text, null],
              last: [200, text, null],
              more: true,
              oversized: {
                name: 'ToolFailed',
                message: expect.stringContaining('4194304 bytes'),
              },
            },
          });
          const query = results.find(
            ({ callId }) => callId === 'query-script/0',
          );
          expect(query?.result.output).toContain(
            'select a substr() to read them',
          );
          expect(query?.result.output).toContain(
            'More rows exist past these 200',
          );
        }),
      );

      // Failure mode: the guest ends (here it throws) while a call it issued is
      // still running. The sandbox interrupts that call, and nothing wrote its
      // result, so its intent and card stayed open forever and a resumed parent
      // counted the child it had launched as still owned.
      it.effect(
        'settles a call its script issued and never awaited, before the script result',
        () =>
          Effect.gen(function* () {
            // `slow` never settles on its own; `fast` settles once `slow`
            // has started, so the guest ends while `slow` has its rows and no
            // result.
            const slowStarted = yield* Deferred.make<void>();
            const probe = newProbe();
            const { session, runId } = yield* openRun;
            yield* runLoop(
              session,
              runId,
              {
                // cast: the built-in's services are the dispatch's.
                script: ScriptTool as unknown as StepTool,
                slow: probeTool(
                  probe,
                  'slow',
                  Deferred.succeed(slowStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                  ),
                  'parallel',
                ),
                fast: probeTool(
                  probe,
                  'fast',
                  Deferred.await(slowStarted),
                  'parallel',
                ),
              },
              [
                {
                  id: 'c1',
                  name: 'script',
                  input: {
                    code: 'const pending = tools.slow({}); await tools.fast({}); throw new Error("the guest gave up");',
                  },
                },
              ],
            );

            const results = yield* committedResults(session, runId);
            const nested = results.findIndex((r) => r.callId === 'c1/0');
            const own = results.findIndex((r) => r.callId === 'c1');
            expect(results[nested]?.disposition).toBe('skipped');
            const skipped = results[nested]?.result;
            // It had started, so the reason carries the unknown-outcome
            // warning.
            expect(skipped?.status === 'error' && skipped.error).toContain(
              'Its outcome is unknown',
            );
            // Committed before the script's own result.
            expect(nested).toBeLessThan(own);
          }),
      );

      it.effect('treats non-safe tools as ordering barriers', () =>
        Effect.gen(function* () {
          const probe = newProbe();
          // The first read holds until the write starts, or for the window a
          // dispatch that ran the write beside it has to start it. No row marks
          // a write that is waiting, and the call's prelude does real I/O, so
          // a live window, not a latch or the test clock, bounds the wait.
          const writeStarted = yield* Deferred.make<void>();
          const { session, runId } = yield* openRun;
          yield* runLoop(
            session,
            runId,
            {
              read_file: probeTool(
                probe,
                'read_file',
                Deferred.await(writeStarted).pipe(
                  Effect.timeoutOrElse({
                    duration: '200 millis',
                    orElse: () => Effect.void,
                  }),
                ),
                'parallel',
              ),
              write_file: probeTool(
                probe,
                'write_file',
                Deferred.succeed(writeStarted, undefined),
              ),
            },
            [
              { id: 'c1', name: 'read_file', input: { n: 1 } },
              { id: 'c2', name: 'write_file', input: { n: 2 } },
              { id: 'c3', name: 'read_file', input: { n: 3 } },
            ],
          );

          expect(probe.maxInFlight).toBe(1);
          expect(probe.events).toEqual([
            'start read_file:{"n":1}',
            'end read_file:{"n":1}',
            'start write_file:{"n":2}',
            'end write_file:{"n":2}',
            'start read_file:{"n":3}',
            'end read_file:{"n":3}',
          ]);
        }),
      );

      // The settlement is the whole transactional boundary: the card that
      // reports it, the edit and the call are all read off the result row,
      // and need no other.
      it.effect('reads the card and the workspace off the tool result', () =>
        Effect.gen(function* () {
          const editingTool: StepTool = {
            definition: { name: 'edit_file', description: 'edit_file' },
            call: () =>
              Effect.succeed({
                status: 'executed',
                output: 'edited',
                edits: [
                  {
                    path: 'notes.tex',
                    lineChanges: { added: 3, removed: 1 },
                  },
                ],
              }),
          };
          // The barriers are ordered, so the second call starting is proof the
          // first has settled; the run is then stopped before delivery.
          const barrierStarted = yield* Deferred.make<void>();
          const { session, runId } = yield* openRun;
          const recorded = recordSessionEvents(session, {
            aggregateId: qualifyAggregateId('run', runId),
          });

          const loop = yield* Effect.forkChild(
            runLoop(
              session,
              runId,
              {
                edit_file: editingTool,
                slow_barrier: probeTool(
                  newProbe(),
                  'slow_barrier',
                  Deferred.succeed(barrierStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                  ),
                ),
              },
              [
                { id: 'c1', name: 'edit_file', input: { path: 'notes.tex' } },
                { id: 'c2', name: 'slow_barrier' },
              ],
            ),
          );
          yield* Deferred.await(barrierStarted);
          yield* Fiber.interrupt(loop);

          const folded = yield* Context.get(session, RunHistory).load(runId);
          expect(settledIds(folded)).toEqual(['c1']);
          // No delivery ran: the edit and the call are folded from the
          // settlement itself. The interrupted barrier's call is not counted,
          // because it never settled.
          expect(folded?.edited).toEqual(['notes.tex']);
          expect(folded?.toolCalls).toBe(1);

          // A card is its call's own rows as the display reads them: the
          // settled call's opens and closes once, and the interrupted second
          // call, whose body started, shows its card open.
          const types = (yield* recorded.read).map((event) => event.type);
          expect(types.filter((type) => type === 'tool.start')).toHaveLength(2);
          expect(types.filter((type) => type === 'tool.end')).toHaveLength(1);
        }),
      );
    });
  },
);
