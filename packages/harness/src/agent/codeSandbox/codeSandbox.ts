// The code sandbox: runs one guest script in a fresh QuickJS runtime on its
// own worker thread, and resolves every `await tools.<name>(args)` the script
// makes through a handler the caller supplies.

import { Worker as WorkerThread } from 'node:worker_threads';

import quickJsWasm from '@jitl/quickjs-wasmfile-release-sync/wasm';
import codeSandboxWorkerSource from 'virtual:code-sandbox-worker';
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Queue,
  Result,
  Schema,
} from 'effect';
import * as Worker from 'effect/workers/Worker';

import { ensureError } from '@utils/errors/errorMessage';

import {
  GUEST_CPU_BUDGET_MS,
  MAX_FANOUT,
  QUICKJS_MEMORY_LIMIT_BYTES,
} from './limits';
import {
  type ScriptEnd,
  type ResultMessage,
  StepReportSchema,
  type WorkerInput,
} from './protocol';

/** The script does not parse. */
class ScriptSyntaxError extends Schema.TaggedError<ScriptSyntaxError>()(
  'ScriptSyntaxError',
  {
    message: Schema.String,
  },
) {}

/** The script threw, or awaits a promise nothing will finish. */
class ScriptFault extends Schema.TaggedError<ScriptFault>()('ScriptFault', {
  name: Schema.String,
  message: Schema.String,
  stack: Schema.optional(Schema.String),
}) {}

/** The script ran out of CPU, heap or time; `message` names which limit. */
class ScriptLimitExceeded extends Schema.TaggedError<ScriptLimitExceeded>()(
  'ScriptLimitExceeded',
  {
    message: Schema.String,
  },
) {}

/** The worker could not start, died, or sent a message that fails its decode. */
class SandboxUnavailable extends Schema.TaggedError<SandboxUnavailable>()(
  'SandboxUnavailable',
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The code sandbox is unavailable: ${ensureError(this.cause).message}`;
  }
}

type ScriptError =
  | ScriptSyntaxError
  | ScriptFault
  | ScriptLimitExceeded
  | SandboxUnavailable;

/** One call the guest issued, numbered in issue order from 0, as its step
 *  report decodes it. */
export type ScriptOp = (typeof StepReportSchema.Type)['ops'][number];

/** How a call finishes: a JSON value, or an error the guest's `await` throws. */
export type ScriptOpResult =
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
   * as its input, and finishes as a tool call does.
   */
  readonly globals?: ReadonlyArray<string>;
  /** The modules the script may `import()`, JavaScript module source by
   *  specifier: data the caller pinned, so a replay loads the same code. */
  readonly modules?: Readonly<Record<string, string>>;
  /**
   * Resolves one issued call. Each runs on its own fiber, and is interrupted
   * if the script ends first (the caller then records it as stopped, once
   * `run` has returned). Results reach the realm one at a time, in
   * the order these effects complete: a caller that completes each at its
   * run history commit makes the realm's delivery order the commit order. A
   * failure is not the guest's to catch: it ends the script with it.
   */
  readonly call: (op: ScriptOp) => Effect.Effect<ScriptOpResult, E, R>;
  /**
   * Each step's newly logged lines, each collapsed to one line of at most
   * 500 characters, and how many lines past the worker's per-step bound the
   * step dropped before them.
   */
  readonly onLog?: (
    lines: ReadonlyArray<string>,
    dropped: number,
  ) => Effect.Effect<void>;
  /**
   * Runs once each result has reached the realm, before the next is
   * taken: a caller replaying recorded results in their recorded order
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
}

const endToResult = (
  end: ScriptEnd,
  cpuBudgetMs: number,
): Effect.Effect<ScriptResult, ScriptError> => {
  switch (end._tag) {
    case 'Returned':
      return Effect.succeed({ value: end.value });
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
      return Effect.fail(
        new ScriptLimitExceeded({
          message: `The script used its ${cpuBudgetMs}ms CPU budget; look for a loop that never awaits.`,
        }),
      );
    case 'MemoryExhausted':
      return Effect.fail(
        new ScriptLimitExceeded({
          message: `The script exceeded its ${QUICKJS_MEMORY_LIMIT_BYTES / (1024 * 1024)} MB heap.`,
        }),
      );
  }
};

const toResultMessage = (seq: number, result: ScriptOpResult): ResultMessage =>
  result._tag === 'Value'
    ? {
        seq,
        ok: true,
        ...(result.value === undefined
          ? {}
          : { json: JSON.stringify(result.value) }),
      }
    : {
        seq,
        ok: false,
        name: result.name,
        message: result.message,
      };

const make = Effect.gen(function* () {
  const platform = yield* Worker.WorkerPlatform;
  // Compiled on the first script and shared: a compiled module crosses to
  // each worker without a copy, so a worker never compiles QuickJS itself.
  // A session that runs no script never compiles it. A failed compile is
  // kept for no time, so the next script tries again.
  const compiled = yield* Effect.tryPromise({
    try: () => WebAssembly.compile(Uint8Array.from(quickJsWasm)),
    catch: (cause) => new SandboxUnavailable({ cause: ensureError(cause) }),
  }).pipe(
    Effect.cachedWithTTL((exit) =>
      Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
    ),
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
        modules: { ...request.modules },
        cpuBudgetMs,
        wasm,
        interrupt,
      };
      // The worker reports once at the start and once per result it is
      // sent, and the loop takes each report before it sends the next, so
      // one report at most is ever waiting.
      const reports = yield* Queue.bounded<
        typeof StepReportSchema.Type,
        SandboxUnavailable
      >(1);
      const worker = yield* platform.spawn<unknown, ResultMessage>(0).pipe(
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
          const report = Schema.decodeUnknownResult(StepReportSchema)(raw);
          return Result.isSuccess(report)
            ? Queue.offer(reports, report.success)
            : Effect.fail(
                new SandboxUnavailable({
                  cause: new Error(
                    `Code sandbox worker sent a malformed message: ${report.failure.message}`,
                  ),
                }),
              );
        })
        .pipe(
          Effect.catch((error) =>
            Queue.fail(
              reports,
              error._tag === 'SandboxUnavailable'
                ? error
                : new SandboxUnavailable({ cause: error }),
            ),
          ),
          Effect.forkScoped,
        );
      // Runs before the worker closes: preempt guest code that is mid-step,
      // which would otherwise hold the worker past its close request.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => Atomics.store(new Int32Array(interrupt), 0, 1)),
      );
      const calls = yield* FiberSet.make<void, never>();
      // Each call finishes once and the worker caps the calls outstanding at
      // `MAX_FANOUT`, so no offer here ever waits.
      const results = yield* Queue.bounded<ResultMessage, E>(MAX_FANOUT);

      let open = 0;
      let report = yield* Queue.take(reports);
      for (;;) {
        if (
          request.onLog !== undefined &&
          (report.logs.length > 0 || report.logsDropped > 0)
        )
          yield* request.onLog(report.logs, report.logsDropped);
        for (const op of report.ops) {
          open += 1;
          yield* FiberSet.run(
            calls,
            request.call(op).pipe(
              Effect.flatMap((result) =>
                Queue.offer(results, toResultMessage(op.seq, result)),
              ),
              // A call that fails, or dies (its value will not serialize,
              // say), fails the queue the loop takes from, so the run ends
              // with that cause rather than waiting out its deadline.
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Queue.failCause(results, cause),
              ),
              Effect.asVoid,
            ),
          );
        }
        if (report.end) return yield* endToResult(report.end, cpuBudgetMs);
        if (open === 0) {
          return yield* new ScriptFault({
            name: 'ScriptStalled',
            message:
              'The script awaits a promise that no tool call will resolve.',
          });
        }
        const next = yield* Queue.take(results);
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
        orElse: () =>
          Effect.fail(
            new ScriptLimitExceeded({
              message: `The script did not finish within ${Duration.format(timeout)}.`,
            }),
          ),
      }),
    );
  };

  return { run };
});

/**
 * Runs guest scripts. A script is the body of an async function; it calls
 * the host as `await tools.<name>(args)`, logs with `console.log`, loads
 * the modules it is given with `await import(specifier)`, and `return`s its
 * result. It has no timers, `Date.now()` or `Math.random()`, so
 * the same results in the same order replay it exactly.
 */
export class CodeSandbox extends Context.Service<
  CodeSandbox,
  {
    readonly run: <E, R>(
      request: ScriptRequest<E, R>,
    ) => Effect.Effect<ScriptResult, ScriptError | E, R>;
  }
>()('@texra-ai/worldline/agent/CodeSandbox') {
  /** Needs the host's worker platform (`NodeWorker.layerPlatform`). */
  static readonly layer: Layer.Layer<
    CodeSandbox,
    never,
    Worker.WorkerPlatform
  > = Layer.effect(CodeSandbox)(make);
}
