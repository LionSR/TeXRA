// The code sandbox worker entry. One worker runs one script in a fresh
// QuickJS runtime, off the host thread, so a guest loop that never yields
// holds this thread and not the extension host or the TUI. Every host bundles
// this file as text and starts it with `eval: true` (see
// `scripts/code-sandbox-worker.mjs`), so no host resolves a worker path.
//
// The realm advances only inside a step: the first evaluates the script, and
// each later one delivers one settlement. A step then drains QuickJS's job
// queue to quiescence and reports the ops the guest issued meanwhile, so the
// same settlements in the same order always issue the same ops in the same
// order. There are no timers: nothing settles except a host delivery.

import { workerData } from 'node:worker_threads';

import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner';
import quickJsReleaseVariant from '@jitl/quickjs-wasmfile-release-sync';
import { Deferred, Effect, Result, Schema, type Scope } from 'effect';
import { WorkerRunnerPlatform } from 'effect/workers/WorkerRunner';
import {
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from 'quickjs-emscripten-core';

import { ensureError } from '@utils/errors/errorMessage';
import { truncateSummary } from '@utils/text/stringUtils';

import {
  MAX_FANOUT,
  QUICKJS_MEMORY_LIMIT_BYTES,
  QUICKJS_STACK_LIMIT_BYTES,
  RUN_LOG_MAX_LINE_LENGTH,
  RUN_LOG_MAX_LINES,
} from './limits';
import { BRIDGE_PRELUDE, DETERMINISM_PRELUDE } from './prelude';
import {
  SettleMessageSchema,
  type StepReportWire,
  type WorkerInput,
  WorkerInputSchema,
} from './protocol';

type ScriptEndWire = NonNullable<StepReportWire['end']>;

const ThrownSchema = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  stack: Schema.optional(Schema.String),
});

/** What the script's source is wrapped in; it shares the first line. */
const SCRIPT_PREFIX = '(async () => {';

/** A syntax error's message with where in the script it is: QuickJS puts
 *  the position in the stack (`at script.js:L:C`), not the message. A
 *  static `import`, which a function body cannot hold, is told the form a
 *  script imports with. */
function withLocation(
  message: string,
  stack: string | undefined,
  source: string,
): string {
  const at = /script\.js:(\d+):(\d+)/.exec(stack ?? '');
  if (at === null) return message;
  const line = Number(at[1]);
  const column = Number(at[2]) - (line === 1 ? SCRIPT_PREFIX.length : 0);
  const before = (source.split('\n')[line - 1] ?? '').slice(0, column - 1);
  const hint = /\bimport\s*$/.test(before)
    ? "; a script imports a module as `const { name } = await import('specifier')`"
    : '';
  return `${message} (line ${line}, column ${Math.max(1, column)})${hint}`;
}

/**
 * How a value thrown out of the realm ends the script: the guest's own
 * rejection (as the bridge describes it), an error QuickJS hands the host, or
 * a host error from the QuickJS API itself. Anything else ends the script as
 * an `Error` carrying its text.
 */
function endFromThrown(thrown: unknown): ScriptEndWire {
  const parsed = Schema.decodeUnknownResult(ThrownSchema)(thrown);
  const error = Result.isSuccess(parsed)
    ? parsed.success
    : { name: 'Error', message: String(thrown) };
  return isOutOfMemory(error)
    ? { _tag: 'MemoryExhausted' }
    : { _tag: 'Threw', ...error };
}

/** QuickJS reports a hit memory limit only as this error. */
function isOutOfMemory(thrown: { name: string; message: string }): boolean {
  return thrown.name === 'InternalError' && thrown.message === 'out of memory';
}

interface Realm {
  /** Evaluate the script and run it to its first wait. */
  readonly begin: () => StepReportWire;
  /** Deliver one settlement and run the realm to its next wait. */
  readonly settle: (message: typeof SettleMessageSchema.Type) => StepReportWire;
}

/** What the host side of a realm tracks across its steps: guest CPU time,
 *  the current step's ops and log lines (reset as each report is taken),
 *  how the script ended, and the next op's number. */
class RealmState {
  cpuUsedMs = 0;
  /** When the running step began; undefined between steps. */
  stepStartedAt: number | undefined = undefined;
  cpuExhausted = false;
  ops: StepReportWire['ops'][number][] = [];
  logs: string[] = [];
  logsDropped = 0;
  end: ScriptEndWire | undefined = undefined;
  nextSeq = 0;
}

/** A QuickJS runtime under the guest limits: it stops guest code once the
 *  host sets the interrupt word or the CPU budget runs out, and loads only
 *  the modules the host passed. */
const openRuntime = Effect.fn('worker.openRuntime')(function* (
  quickJs: QuickJSWASMModule,
  input: WorkerInput,
  state: RealmState,
): Effect.fn.Return<QuickJSRuntime, Error, Scope.Scope> {
  const interrupt = new Int32Array(input.interrupt);
  const runtime = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        quickJs.newRuntime({
          memoryLimitBytes: QUICKJS_MEMORY_LIMIT_BYTES,
          maxStackSizeBytes: QUICKJS_STACK_LIMIT_BYTES,
          interruptHandler: () => {
            if (Atomics.load(interrupt, 0) !== 0) return true;
            if (state.stepStartedAt === undefined) return false;
            state.cpuExhausted ||=
              state.cpuUsedMs + performance.now() - state.stepStartedAt >=
              input.cpuBudgetMs;
            return state.cpuExhausted;
          },
        }),
      catch: ensureError,
    }),
    (runtime) => Effect.sync(() => runtime.dispose()),
  );
  // A specifier names a module whole: one the host passed loads, any
  // other (a relative path included) rejects the import.
  const offered = Object.keys(input.modules).map((name) => `"${name}"`);
  runtime.setModuleLoader((name) => {
    const source = Object.hasOwn(input.modules, name)
      ? input.modules[name]
      : undefined;
    return (
      source ?? {
        error: new Error(
          `No module "${name}" is offered to this script; it may import ${offered.length === 0 ? 'none' : offered.join(', ')}.`,
        ),
      }
    );
  });
  return runtime;
});

/** Install the globals the bridge prelude calls (`__csIssue` issues an op,
 *  `__csLog` keeps a log line, `__csDone` records how the script ended) and
 *  `__csConfig`, the JSON the bridge configures itself from. */
function installHostFunctions(
  context: QuickJSContext,
  input: WorkerInput,
  state: RealmState,
): void {
  const hostFunctions: Record<
    string,
    (...args: QuickJSHandle[]) => QuickJSHandle | undefined
  > = {
    __csIssue: (name, json, phase) => {
      const seq = state.nextSeq++;
      state.ops.push({
        seq,
        name: context.getString(name),
        input: context.getString(json),
        phase:
          context.typeof(phase) === 'string' ? context.getString(phase) : null,
      });
      return context.newNumber(seq);
    },
    __csLog: (text) => {
      state.logs.push(
        truncateSummary(context.getString(text), RUN_LOG_MAX_LINE_LENGTH),
      );
      if (state.logs.length > RUN_LOG_MAX_LINES) {
        state.logs.shift();
        state.logsDropped += 1;
      }
      return undefined;
    },
    __csDone: (ok, payload) => {
      const json =
        context.typeof(payload) === 'string'
          ? context.getString(payload)
          : undefined;
      state.end ??= context.dump(ok)
        ? { _tag: 'Returned', value: json }
        : endFromThrown(JSON.parse(json ?? 'null'));
      return undefined;
    },
  };
  for (const [name, fn] of Object.entries(hostFunctions)) {
    const handle = context.newFunction(name, fn);
    context.setProp(context.global, name, handle);
    handle.dispose();
  }
  const config = context.newString(
    JSON.stringify({
      tools: input.tools,
      globals: input.globals,
      maxFanout: MAX_FANOUT,
    }),
  );
  context.setProp(context.global, '__csConfig', config);
  config.dispose();
}

/** How a script that failed to evaluate ends: a syntax error, told where in
 *  the script it is, or whatever else evaluation threw. */
function evaluationFailureEnd(thrown: unknown, source: string): ScriptEndWire {
  const end = endFromThrown(thrown);
  return end._tag === 'Threw' && end.name === 'SyntaxError'
    ? {
        _tag: 'SyntaxError',
        message: withLocation(end.message, end.stack, source),
      }
    : end;
}

const openRealm = Effect.fn('worker.openRealm')(function* (
  input: WorkerInput,
): Effect.fn.Return<Realm, Error, Scope.Scope> {
  const quickJs = yield* Effect.tryPromise({
    try: () =>
      newQuickJSWASMModuleFromVariant(
        newVariant(quickJsReleaseVariant, { wasmModule: input.wasm }),
      ),
    catch: ensureError,
  });
  const state = new RealmState();
  const runtime = yield* openRuntime(quickJs, input, state);
  const context = yield* Effect.acquireRelease(
    Effect.try({ try: () => runtime.newContext(), catch: ensureError }),
    (context) => Effect.sync(() => context.dispose()),
  );
  yield* Effect.try({
    try: () => installHostFunctions(context, input, state),
    catch: ensureError,
  });
  const bridge = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const handle = evaluate(context, BRIDGE_PRELUDE, 'sandbox-bridge.js');
        evaluate(context, DETERMINISM_PRELUDE, 'sandbox-prelude.js').dispose();
        return handle;
      },
      catch: ensureError,
    }),
    (handle) => Effect.sync(() => handle.dispose()),
  );
  const start = yield* Effect.acquireRelease(
    Effect.sync(() => context.getProp(bridge, 'start')),
    (handle) => Effect.sync(() => handle.dispose()),
  );
  const settle = yield* Effect.acquireRelease(
    Effect.sync(() => context.getProp(bridge, 'settle')),
    (handle) => Effect.sync(() => handle.dispose()),
  );

  /** Run `body` and the job queue it leaves, then take the step's report. */
  const step = (body: () => void): StepReportWire => {
    const startedAt = performance.now();
    state.stepStartedAt = startedAt;
    try {
      body();
      const drained = runtime.executePendingJobs();
      if (drained.error) {
        const thrown: unknown = context.dump(drained.error);
        drained.error.dispose();
        state.end ??= endFromThrown(thrown);
      }
    } catch (error) {
      state.end ??= endFromThrown(error);
    } finally {
      state.cpuUsedMs += performance.now() - startedAt;
      state.stepStartedAt = undefined;
    }
    if (state.cpuExhausted) state.end = { _tag: 'CpuExhausted' };
    const report: StepReportWire = {
      ops: state.ops,
      logs: state.logs,
      logsDropped: state.logsDropped,
      ...(state.end ? { end: state.end } : {}),
    };
    state.ops = [];
    state.logs = [];
    state.logsDropped = 0;
    return report;
  };

  /** Call a bridge function; a value it throws becomes the script's end. */
  const callBridge = (fn: QuickJSHandle, ...args: QuickJSHandle[]): void => {
    const result = context.callFunction(fn, context.undefined, ...args);
    for (const arg of args) arg.dispose();
    if (result.error) {
      const thrown: unknown = context.dump(result.error);
      result.error.dispose();
      state.end ??= endFromThrown(thrown);
      return;
    }
    result.value.dispose();
  };

  return {
    begin: () =>
      step(() => {
        // The prefix shares the script's first line, so reported line
        // numbers match the script as written.
        const body = context.evalCode(
          `${SCRIPT_PREFIX}${input.source}\n})`,
          'script.js',
          { type: 'global', strict: true },
        );
        if (body.error) {
          const thrown: unknown = context.dump(body.error);
          body.error.dispose();
          state.end ??= evaluationFailureEnd(thrown, input.source);
          return;
        }
        callBridge(start, body.value);
      }),
    settle: (message) =>
      step(() => {
        // A failure crosses as `{ name, message }` JSON; a value with no
        // JSON text resolves as undefined.
        const payload = message.ok
          ? message.json
          : JSON.stringify({ name: message.name, message: message.message });
        callBridge(
          settle,
          context.newNumber(message.seq),
          message.ok ? context.true : context.false,
          payload === undefined
            ? context.undefined
            : context.newString(payload),
        );
      }),
  } satisfies Realm;
});

function evaluate(
  context: QuickJSContext,
  source: string,
  filename: string,
): QuickJSHandle {
  return context.unwrapResult(
    context.evalCode(source, filename, { type: 'global', strict: true }),
  );
}

const program = Effect.gen(function* () {
  const input =
    yield* Schema.decodeUnknownEffect(WorkerInputSchema)(workerData);
  const realm = yield* openRealm(input);
  const runner = yield* (yield* WorkerRunnerPlatform).start<
    StepReportWire,
    unknown
  >();
  // A host message that fails its decode ends the worker, which the host
  // sees as the sandbox going away.
  const fatal = yield* Deferred.make<never, Error>();
  yield* runner.send(0, realm.begin());
  yield* Effect.raceFirst(
    runner.run((_port, raw) => {
      const message = Schema.decodeUnknownResult(SettleMessageSchema)(raw);
      return Result.isSuccess(message)
        ? runner.send(0, realm.settle(message.success))
        : Deferred.fail(
            fatal,
            new Error(
              `Code sandbox worker received a malformed message: ${message.failure.message}`,
            ),
          );
    }),
    Deferred.await(fatal),
  );
}).pipe(Effect.scoped, Effect.provide(NodeWorkerRunner.layer));

// Worker entry: no process runtime exists in the worker.
NodeRuntime.runMain(program);
