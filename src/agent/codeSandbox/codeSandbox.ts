// The code sandbox: runs one guest script in a fresh QuickJS runtime on its
// own worker thread, and resolves every `await tools.<name>(args)` the script
// makes through a handler the caller supplies.

import { Worker as WorkerThread } from 'node:worker_threads';

import quickJsWasm from '@jitl/quickjs-wasmfile-release-sync/wasm';
import codeSandboxWorkerSource from 'virtual:code-sandbox-worker';
import {
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Queue,
} from 'effect';
import * as Worker from 'effect/workers/Worker';
import { z } from 'zod';

import { ensureError } from '@utils/errors/errorMessage';

import {
  GUEST_CPU_BUDGET_MS,
  QUICKJS_MEMORY_LIMIT_BYTES,
  RUN_LOG_MAX_LINES,
} from './limits';
import {
  type ScriptEnd,
  type SettleMessage,
  StepReportSchema,
  type WorkerInput,
} from './protocol';

/** The script does not parse. */
class ScriptSyntaxError extends Data.TaggedError('ScriptSyntaxError')<{
  readonly message: string;
}> {}

/** The script threw, or awaits a promise nothing will settle. */
class ScriptFault extends Data.TaggedError('ScriptFault')<{
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}> {}

class ScriptCpuExhausted extends Data.TaggedError('ScriptCpuExhausted')<{
  readonly budgetMs: number;
}> {
  override get message(): string {
    return `The script used its ${this.budgetMs}ms CPU budget; look for a loop that never awaits.`;
  }
}

class ScriptMemoryExhausted extends Data.TaggedError('ScriptMemoryExhausted')<{
  readonly limitBytes: number;
}> {
  override get message(): string {
    return `The script exceeded its ${this.limitBytes / (1024 * 1024)} MB heap.`;
  }
}

class ScriptTimedOut extends Data.TaggedError('ScriptTimedOut')<{
  readonly timeout: Duration.Duration;
}> {
  override get message(): string {
    return `The script did not finish within ${Duration.format(this.timeout)}.`;
  }
}

/** The worker could not start, died, or sent a message that fails its decode. */
class SandboxUnavailable extends Data.TaggedError('SandboxUnavailable')<{
  readonly cause: Error;
}> {
  override get message(): string {
    return `The code sandbox is unavailable: ${this.cause.message}`;
  }
}

type ScriptError =
  | ScriptSyntaxError
  | ScriptFault
  | ScriptCpuExhausted
  | ScriptMemoryExhausted
  | ScriptTimedOut
  | SandboxUnavailable;

/** One call the guest issued, numbered in issue order from 0. */
export interface ScriptOp {
  readonly seq: number;
  readonly name: string;
  readonly input: unknown;
  /** The title of the guest's latest `phase()` call, if it made one. */
  readonly phase: string | null;
}

/** How a call settles: a JSON value, or an error the guest's `await` throws. */
export type ScriptSettlement =
  | { readonly _tag: 'Value'; readonly value: unknown }
  | {
      readonly _tag: 'Failure';
      readonly name: string;
      readonly message: string;
    };

interface ScriptRequest<E, R> {
  readonly source: string;
  /**
   * The names the realm installs as `tools.<name>`: data the caller takes
   * from the step's pinned registry snapshot, never a live catalog.
   */
  readonly tools: ReadonlyArray<string>;
  /**
   * The host functions the realm installs as globals: `name(...args)` issues
   * an op named `name()`, which no tool name can be, with the argument list
   * as its input, and settles as a tool call does.
   */
  readonly globals?: ReadonlyArray<string>;
  /**
   * Resolves one issued call. Each runs on its own fiber, and is interrupted
   * if the script ends first. Settlements reach the realm one at a time, in
   * the order these effects complete: a caller that completes each at its
   * ledger commit makes the realm's delivery order the commit order. A
   * failure is not the guest's to catch: it ends the script with it.
   */
  readonly call: (op: ScriptOp) => Effect.Effect<ScriptSettlement, E, R>;
  /** Each step's newly logged lines, as the guest logged them. */
  readonly onLog?: (lines: ReadonlyArray<string>) => Effect.Effect<void>;
  /**
   * Runs once each settlement has reached the realm, before the next is
   * taken: a caller replaying recorded settlements in their recorded order
   * completes the next one only after the one before it was delivered.
   */
  readonly onDelivered?: (seq: number) => Effect.Effect<void>;
  /** The wall deadline for the whole script, host waits included. */
  readonly timeout: Duration.Input;
  /** Guest CPU budget; defaults to {@link GUEST_CPU_BUDGET_MS}. */
  readonly cpuBudgetMs?: number;
}

interface ScriptResult {
  /** What the script returned, decoded from JSON; undefined for no value. */
  readonly value: unknown;
  /**
   * The last {@link RUN_LOG_MAX_LINES} `console.log` lines, in order, each
   * collapsed to one line of at most 500 characters.
   */
  readonly logs: ReadonlyArray<string>;
  /** How many earlier lines the tail dropped. */
  readonly logsOmitted: number;
}

const endToResult = (
  end: ScriptEnd,
  log: Pick<ScriptResult, 'logs' | 'logsOmitted'>,
  cpuBudgetMs: number,
): Effect.Effect<ScriptResult, ScriptError> => {
  switch (end._tag) {
    case 'Returned':
      return Effect.succeed({ value: end.value, ...log });
    case 'Threw':
      return Effect.fail(
        new ScriptFault({
          name: end.name,
          message: end.message,
          ...(end.stack === undefined ? {} : { stack: end.stack }),
        }),
      );
    case 'SyntaxError':
      return Effect.fail(new ScriptSyntaxError({ message: end.message }));
    case 'CpuExhausted':
      return Effect.fail(new ScriptCpuExhausted({ budgetMs: cpuBudgetMs }));
    case 'MemoryExhausted':
      return Effect.fail(
        new ScriptMemoryExhausted({ limitBytes: QUICKJS_MEMORY_LIMIT_BYTES }),
      );
  }
};

const toSettleMessage = (
  seq: number,
  settlement: ScriptSettlement,
): SettleMessage =>
  settlement._tag === 'Value'
    ? {
        seq,
        ok: true,
        ...(settlement.value === undefined
          ? {}
          : { json: JSON.stringify(settlement.value) }),
      }
    : {
        seq,
        ok: false,
        name: settlement.name,
        message: settlement.message,
      };

const make = Effect.gen(function* () {
  const platform = yield* Worker.WorkerPlatform;
  // Compiled on the first script and shared: a compiled module crosses to
  // each worker without a copy, so a worker never compiles QuickJS itself.
  // A session that runs no script never compiles it.
  const compiled = yield* Effect.cached(
    Effect.tryPromise({
      try: () => WebAssembly.compile(Uint8Array.from(quickJsWasm)),
      catch: (cause) => new SandboxUnavailable({ cause: ensureError(cause) }),
    }),
  );

  const run = <E, R>(
    request: ScriptRequest<E, R>,
  ): Effect.Effect<ScriptResult, ScriptError | E, R> => {
    const cpuBudgetMs = request.cpuBudgetMs ?? GUEST_CPU_BUDGET_MS;
    const timeout = Duration.fromInputUnsafe(request.timeout);
    return Effect.gen(function* () {
      const wasm = yield* compiled;
      const interrupt = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const workerData: WorkerInput = {
        source: request.source,
        tools: [...request.tools],
        globals: [...(request.globals ?? [])],
        cpuBudgetMs,
        wasm,
        interrupt,
      };
      const reports = yield* Queue.unbounded<
        z.output<typeof StepReportSchema>,
        SandboxUnavailable
      >();
      const worker = yield* platform.spawn<unknown, SettleMessage>(0).pipe(
        Effect.provideService(
          Worker.Spawner,
          () =>
            new WorkerThread(codeSandboxWorkerSource, {
              eval: true,
              workerData,
            }),
        ),
        Effect.mapError((cause) => new SandboxUnavailable({ cause })),
      );
      // The worker lives as long as this fiber: closing the scope asks it to
      // close and terminates it if it does not.
      yield* worker
        .run((raw) => {
          const report = StepReportSchema.safeParse(raw);
          return report.success
            ? Queue.offer(reports, report.data)
            : Effect.fail(
                new Error(
                  `Code sandbox worker sent a malformed message: ${z.prettifyError(report.error)}`,
                ),
              );
        })
        .pipe(
          Effect.catch((cause) =>
            Queue.fail(reports, new SandboxUnavailable({ cause })),
          ),
          Effect.forkScoped,
        );
      // Runs before the worker closes: preempt guest code that is mid-step,
      // which would otherwise hold the worker past its close request.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => Atomics.store(new Int32Array(interrupt), 0, 1)),
      );
      const calls = yield* FiberSet.make<void, never>();
      const settled = yield* Queue.unbounded<SettleMessage, E>();

      const logs: string[] = [];
      let logsOmitted = 0;
      let open = 0;
      let report = yield* Queue.take(reports);
      for (;;) {
        if (request.onLog !== undefined && report.logs.length > 0)
          yield* request.onLog(report.logs);
        logs.push(...report.logs);
        const overflow = Math.max(0, logs.length - RUN_LOG_MAX_LINES);
        logs.splice(0, overflow);
        logsOmitted += report.logsDropped + overflow;
        for (const op of report.ops) {
          open += 1;
          yield* FiberSet.run(
            calls,
            request.call(op).pipe(
              Effect.flatMap((settlement) =>
                Queue.offer(settled, toSettleMessage(op.seq, settlement)),
              ),
              // A call that fails, or dies (its value will not serialize,
              // say), fails the queue the loop takes from, so the run ends
              // with that cause rather than waiting out its deadline.
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Queue.failCause(settled, cause),
              ),
              Effect.asVoid,
            ),
          );
        }
        if (report.end)
          return yield* endToResult(
            report.end,
            { logs, logsOmitted },
            cpuBudgetMs,
          );
        if (open === 0) {
          return yield* new ScriptFault({
            name: 'ScriptStalled',
            message:
              'The script awaits a promise that no tool call will settle.',
          });
        }
        const next = yield* Queue.take(settled);
        open -= 1;
        yield* worker
          .send(next)
          .pipe(Effect.mapError((cause) => new SandboxUnavailable({ cause })));
        if (request.onDelivered !== undefined)
          yield* request.onDelivered(next.seq);
        report = yield* Queue.take(reports);
      }
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ScriptTimedOut({ timeout })),
      }),
    );
  };

  return { run };
});

/**
 * Runs guest scripts. A script is the body of an async function; it calls
 * the host as `await tools.<name>(args)`, logs with `console.log`, and
 * `return`s its result. It has no timers, `Date.now()` or `Math.random()`, so
 * the same settlements in the same order replay it exactly.
 */
export class CodeSandbox extends Context.Service<
  CodeSandbox,
  {
    readonly run: <E, R>(
      request: ScriptRequest<E, R>,
    ) => Effect.Effect<ScriptResult, ScriptError | E, R>;
  }
>()('@texra/agent/CodeSandbox') {
  /** Needs the host's worker platform (`NodeWorker.layerPlatform`). */
  static readonly layer: Layer.Layer<
    CodeSandbox,
    never,
    Worker.WorkerPlatform
  > = Layer.effect(CodeSandbox)(make);
}
