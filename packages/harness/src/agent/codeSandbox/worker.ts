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
import { Deferred, Effect, type Scope } from 'effect';
import { WorkerRunnerPlatform } from 'effect/workers/WorkerRunner';
import {
  type QuickJSContext,
  type QuickJSHandle,
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from 'quickjs-emscripten-core';
import { z } from 'zod';

import { ensureError } from '@utils/errors/errorMessage';
import { truncateSummary } from '@utils/text/stringUtils';

import {
  MAX_FANOUT,
  QUICKJS_MEMORY_LIMIT_BYTES,
  QUICKJS_STACK_LIMIT_BYTES,
  RUN_LOG_MAX_LINE_LENGTH,
  RUN_LOG_MAX_LINES,
} from './limits';
import {
  SettleMessageSchema,
  type StepReportWire,
  type WorkerInput,
  WorkerInputSchema,
} from './protocol';

type ScriptEndWire = NonNullable<StepReportWire['end']>;

/**
 * The guest-facing globals and the two functions the host calls. It captures
 * the host functions, deletes their temporary globals, and evaluates to
 * `{ start, settle }`, which stay host-side handles. `tools.<name>(args)`
 * returns a realm-native promise whose resolver waits in a realm-side table
 * keyed by op number; the host never holds a guest object, and only JSON text
 * crosses in either direction.
 */
const BRIDGE_PRELUDE = `
'use strict';
(() => {
  const issue = globalThis.__csIssue;
  const log = globalThis.__csLog;
  const done = globalThis.__csDone;
  const config = JSON.parse(globalThis.__csConfig);
  let currentPhase = null;
  for (const name of ['__csIssue', '__csLog', '__csDone', '__csConfig']) {
    delete globalThis[name];
  }
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const freeze = Object.freeze;
  const RealPromise = Promise;
  const RealError = Error;
  const RealTypeError = TypeError;
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });

  const pending = new Map();
  const call = (name, input, label) => {
    if (pending.size >= config.maxFanout) {
      return RealPromise.reject(
        new RealError('A script may have at most ' + config.maxFanout + ' calls outstanding.'),
      );
    }
    let json;
    try {
      json = stringify(input === undefined ? {} : input);
    } catch (err) {
      json = undefined;
    }
    if (typeof json !== 'string') {
      return RealPromise.reject(
        new RealTypeError(label + '() takes a JSON-serializable argument.'),
      );
    }
    const seq = issue(name, json, currentPhase);
    return new RealPromise((resolve, reject) => pending.set(seq, { resolve, reject }));
  };
  const tools = Object.create(null);
  for (const name of config.tools) tools[name] = (input) => call(name, input, 'tools.' + name);
  define('tools', freeze(tools));
  for (const name of config.globals) define(name, (...args) => call(name + '()', args, name));
  define('phase', (title) => {
    currentPhase = String(title);
  });
  const show = (value) => {
    if (typeof value === 'string') return value;
    try {
      const json = stringify(value);
      return json === undefined ? String(value) : json;
    } catch (err) {
      return String(value);
    }
  };
  define('console', freeze({ log: (...values) => log(values.map(show).join(' ')) }));

  const describe = (err) =>
    stringify({
      name: err && typeof err === 'object' && err.name ? String(err.name) : 'Error',
      message: err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err),
      stack: err && typeof err === 'object' && err.stack ? String(err.stack) : undefined,
    });

  return freeze({
    start: (body) => {
      body().then(
        (value) => {
          let json;
          try {
            json = stringify(value);
          } catch (err) {
            done(false, describe(new RealTypeError('The script returned a value that is not JSON-serializable.')));
            return;
          }
          done(true, json);
        },
        (err) => done(false, describe(err)),
      );
    },
    settle: (seq, ok, payload) => {
      const entry = pending.get(seq);
      if (entry === undefined) throw new RealError('No call ' + seq + ' is outstanding.');
      pending.delete(seq);
      if (ok) {
        entry.resolve(payload === undefined ? undefined : parse(payload));
        return;
      }
      const failure = parse(payload);
      const error = new RealError(failure.message);
      error.name = failure.name;
      entry.reject(error);
    },
  });
})()
`;

/**
 * Nondeterminism and dynamic-code guards. Replay requires stable call order,
 * while scripts have no reason to compile source at runtime.
 */
const DETERMINISM_PRELUDE = `
'use strict';
(() => {
  const guard = (what, hint) =>
    function () {
      throw new Error(
        what + ' is unavailable in scripts (breaks resume); ' + hint,
      );
    };
  Object.defineProperty(Math, 'random', {
    value: guard('Math.random()', 'vary inputs by their index instead.'),
    writable: false,
    configurable: false,
  });

  const RealDate = Date;
  function GuardedDate(...args) {
    if (args.length === 0) {
      throw new Error(
        'new Date() without arguments is unavailable in scripts (breaks resume); write timestamps into the script.',
      );
    }
    const instance = Reflect.construct(RealDate, args);
    return new.target ? instance : String(instance);
  }
  GuardedDate.prototype = RealDate.prototype;
  GuardedDate.parse = RealDate.parse;
  GuardedDate.UTC = RealDate.UTC;
  Object.defineProperty(GuardedDate, 'now', {
    value: guard('Date.now()', 'write timestamps into the script.'),
    writable: false,
    configurable: false,
  });
  Object.defineProperty(RealDate.prototype, 'constructor', {
    value: GuardedDate,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globalThis, 'Date', {
    value: GuardedDate,
    writable: false,
    configurable: false,
  });

  Object.defineProperty(globalThis, 'Intl', {
    value: undefined,
    writable: false,
    configurable: false,
  });

  const dynamicCodeDisabled = function () {
    throw new TypeError('Dynamic code generation is disallowed in scripts.');
  };
  const constructors = [
    Function,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
  ];
  for (const constructor of constructors) {
    Object.defineProperty(constructor.prototype, 'constructor', {
      value: dynamicCodeDisabled,
      writable: false,
      configurable: false,
    });
  }
  for (const name of ['Function', 'eval']) {
    Object.defineProperty(globalThis, name, {
      value: dynamicCodeDisabled,
      writable: false,
      configurable: false,
    });
  }

  for (const method of ['then', 'catch', 'finally']) {
    Object.defineProperty(Promise.prototype, method, {
      value: Promise.prototype[method],
      writable: false,
      configurable: false,
    });
  }
})();
`;

const ThrownSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});

/** What the script's source is wrapped in; it shares the first line. */
const SCRIPT_PREFIX = '(async () => {';

/** A syntax error's message with where in the script it is: QuickJS puts
 *  the position in the stack (`at script.js:L:C`), not the message. */
function withLocation(message: string, stack: string | undefined): string {
  const at = /script\.js:(\d+):(\d+)/.exec(stack ?? '');
  if (at === null) return message;
  const line = Number(at[1]);
  const column = Number(at[2]) - (line === 1 ? SCRIPT_PREFIX.length : 0);
  return `${message} (line ${line}, column ${Math.max(1, column)})`;
}

/**
 * How a value thrown out of the realm ends the script: the guest's own
 * rejection (as the bridge describes it), an error QuickJS hands the host, or
 * a host error from the QuickJS API itself. Anything else ends the script as
 * an `Error` carrying its text.
 */
function endFromThrown(thrown: unknown): ScriptEndWire {
  const parsed = ThrownSchema.safeParse(thrown);
  const error = parsed.success
    ? parsed.data
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
  readonly settle: (
    message: z.infer<typeof SettleMessageSchema>,
  ) => StepReportWire;
}

const openRealm = (
  input: WorkerInput,
): Effect.Effect<Realm, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const quickJs = yield* Effect.tryPromise({
      try: () =>
        newQuickJSWASMModuleFromVariant(
          newVariant(quickJsReleaseVariant, { wasmModule: input.wasm }),
        ),
      catch: ensureError,
    });
    const interrupt = new Int32Array(input.interrupt);
    let cpuUsedMs = 0;
    let stepStartedAt: number | undefined;
    let cpuExhausted = false;
    const runtime = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          quickJs.newRuntime({
            memoryLimitBytes: QUICKJS_MEMORY_LIMIT_BYTES,
            maxStackSizeBytes: QUICKJS_STACK_LIMIT_BYTES,
            interruptHandler: () => {
              if (Atomics.load(interrupt, 0) !== 0) return true;
              if (stepStartedAt === undefined) return false;
              cpuExhausted ||=
                cpuUsedMs + performance.now() - stepStartedAt >=
                input.cpuBudgetMs;
              return cpuExhausted;
            },
          }),
        catch: ensureError,
      }),
      (runtime) => Effect.sync(() => runtime.dispose()),
    );
    const context = yield* Effect.acquireRelease(
      Effect.try({ try: () => runtime.newContext(), catch: ensureError }),
      (context) => Effect.sync(() => context.dispose()),
    );

    // What the current step collects; reset as each report is taken.
    let ops: StepReportWire['ops'] = [];
    let logs: string[] = [];
    let logsDropped = 0;
    let end: ScriptEndWire | undefined;
    let nextSeq = 0;

    yield* Effect.try({
      try: () => {
        defineHostFunction(context, '__csIssue', (name, json, phase) => {
          const seq = nextSeq++;
          ops.push({
            seq,
            name: context.getString(name),
            input: context.getString(json),
            phase:
              context.typeof(phase) === 'string'
                ? context.getString(phase)
                : null,
          });
          return context.newNumber(seq);
        });
        defineHostFunction(context, '__csLog', (text) => {
          logs.push(
            truncateSummary(context.getString(text), RUN_LOG_MAX_LINE_LENGTH),
          );
          if (logs.length > RUN_LOG_MAX_LINES) {
            logs.shift();
            logsDropped += 1;
          }
          return undefined;
        });
        defineHostFunction(context, '__csDone', (ok, payload) => {
          const json =
            context.typeof(payload) === 'string'
              ? context.getString(payload)
              : undefined;
          end ??= context.dump(ok)
            ? { _tag: 'Returned', value: json }
            : endFromThrown(JSON.parse(json ?? 'null'));
          return undefined;
        });
        const config = context.newString(
          JSON.stringify({
            tools: input.tools,
            globals: input.globals,
            maxFanout: MAX_FANOUT,
          }),
        );
        context.setProp(context.global, '__csConfig', config);
        config.dispose();
      },
      catch: ensureError,
    });
    const bridge = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const handle = evaluate(context, BRIDGE_PRELUDE, 'sandbox-bridge.js');
          evaluate(
            context,
            DETERMINISM_PRELUDE,
            'sandbox-prelude.js',
          ).dispose();
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
      stepStartedAt = performance.now();
      try {
        body();
        const drained = runtime.executePendingJobs();
        if (drained.error) {
          const thrown: unknown = context.dump(drained.error);
          drained.error.dispose();
          end ??= endFromThrown(thrown);
        }
      } catch (error) {
        end ??= endFromThrown(error);
      } finally {
        cpuUsedMs += performance.now() - stepStartedAt;
        stepStartedAt = undefined;
      }
      if (cpuExhausted) end = { _tag: 'CpuExhausted' };
      const report: StepReportWire = {
        ops,
        logs,
        logsDropped,
        ...(end ? { end } : {}),
      };
      ops = [];
      logs = [];
      logsDropped = 0;
      return report;
    };

    /** Call a bridge function; a value it throws becomes the script's end. */
    const callBridge = (fn: QuickJSHandle, ...args: QuickJSHandle[]): void => {
      const result = context.callFunction(fn, context.undefined, ...args);
      for (const arg of args) arg.dispose();
      if (result.error) {
        const thrown: unknown = context.dump(result.error);
        result.error.dispose();
        end ??= endFromThrown(thrown);
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
            const thrown = endFromThrown(context.dump(body.error));
            body.error.dispose();
            end ??=
              thrown._tag === 'Threw' && thrown.name === 'SyntaxError'
                ? {
                    _tag: 'SyntaxError',
                    message: withLocation(thrown.message, thrown.stack),
                  }
                : thrown;
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

function defineHostFunction(
  context: QuickJSContext,
  name: string,
  fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined,
): void {
  const handle = context.newFunction(name, fn);
  context.setProp(context.global, name, handle);
  handle.dispose();
}

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
  const input = yield* Effect.try({
    try: () => WorkerInputSchema.parse(workerData),
    catch: ensureError,
  });
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
      const message = SettleMessageSchema.safeParse(raw);
      return message.success
        ? runner.send(0, realm.settle(message.data))
        : Deferred.fail(
            fatal,
            new Error(
              `Code sandbox worker received a malformed message: ${z.prettifyError(message.error)}`,
            ),
          );
    }),
    Deferred.await(fatal),
  );
}).pipe(Effect.scoped, Effect.provide(NodeWorkerRunner.layer));

// Worker entry: no process runtime exists in the worker.
NodeRuntime.runMain(program);
