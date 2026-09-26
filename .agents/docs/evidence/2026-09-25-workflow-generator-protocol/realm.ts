/**
 * The QuickJS side: a realm that holds the script's generators and exposes
 * exactly two trusted handles to the host, `step` and `registerMain`, neither
 * reachable from guest code. Guest code runs only inside a step, which is a
 * synchronous call under a CPU deadline. There are no promises in the realm,
 * so there is no job queue to pump.
 */
import quickJsReleaseVariant from '@jitl/quickjs-wasmfile-release-sync';
import {
  memoizePromiseFactory,
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import { Data, Effect, Scope } from 'effect';

import { StepReplySchema, type StepReply } from './ops';

export class ScriptFault extends Data.TaggedError('ScriptFault')<{
  readonly message: string;
}> {}

const getQuickJs = memoizePromiseFactory(() =>
  newQuickJSWASMModuleFromVariant(quickJsReleaseVariant),
);

/** Guards: no dynamic code, no clock, no randomness, no host reachability. */
const GUARD_PRELUDE = `
'use strict';
(() => {
  const lock = (obj, name, value) =>
    Object.defineProperty(obj, name, { value, writable: false, configurable: false });
  const refuse = (what) => function () { throw new Error(what + ' is unavailable in workflow scripts'); };
  lock(Math, 'random', refuse('Math.random()'));
  lock(Date, 'now', refuse('Date.now()'));
  const noCode = function () { throw new TypeError('Dynamic code generation is disallowed'); };
  const constructors = [
    Function,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
  ];
  for (const C of constructors) {
    lock(C.prototype, 'constructor', noCode);
  }
  lock(globalThis, 'Function', noCode);
  lock(globalThis, 'eval', noCode);
})();
`;

/**
 * Operation constructors plus the step machine. The expression evaluates to
 * [step, registerMain]; both stay host-side handles.
 */
const PROTOCOL_PRELUDE = `
'use strict';
(() => {
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const OP = Symbol('workflow.op');
  const GeneratorFunction = Object.getPrototypeOf(function* () {});
  const isGenFn = (f) => typeof f === 'function' && Object.getPrototypeOf(f) === GeneratorFunction;
  const isOp = (x) => x !== null && typeof x === 'object' && typeof x[OP] === 'string';
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });

  const makeOp = (tag, fields) => {
    const op = {
      [OP]: tag,
      ...fields,
      // yield* op  ===  yield op, then resume with the host's result.
      *[Symbol.iterator]() { return yield op; },
    };
    return Object.freeze(op);
  };
  const node = (x, where) => {
    if (isOp(x) || isGenFn(x)) return x;
    throw new TypeError(where + ' expects an operation such as agent(...) or a generator function (function* () { ... })');
  };

  define('agent', (prompt, options) => makeOp('Agent', { prompt, options: options ?? {} }));
  define('all', (items, options) => {
    if (!Array.isArray(items)) throw new TypeError('all(items) expects an array');
    return makeOp('All', {
      items: items.map((x, i) => node(x, 'all() item ' + i)),
      concurrency: options?.concurrency ?? null,
    });
  });
  define('forEach', (items, fn, options) => {
    if (!Array.isArray(items)) throw new TypeError('forEach(items, fn) expects an array');
    return globalThis.all(items.map((x, i) => fn(x, i)), options);
  });
  define('attempt', (body) => makeOp('Attempt', { body: node(body, 'attempt()') }));
  define('retry', (body, options) =>
    makeOp('Retry', { body: node(body, 'retry()'), times: options?.times ?? null }));
  define('timeout', (body, ms) => makeOp('Timeout', { body: node(body, 'timeout()'), ms }));

  const fns = new Map();
  const gens = new Map();
  let nextFn = 0;
  let nextGen = 0;
  const wire = (x) => {
    if (isGenFn(x)) {
      const fn = nextFn++;
      fns.set(fn, x);
      return { _tag: 'Branch', fn };
    }
    switch (x[OP]) {
      case 'Agent': return { _tag: 'Agent', prompt: x.prompt, options: x.options };
      case 'All': return { _tag: 'All', items: x.items.map(wire), concurrency: x.concurrency };
      case 'Attempt': return { _tag: 'Attempt', body: wire(x.body) };
      case 'Retry': return { _tag: 'Retry', body: wire(x.body), times: x.times };
      case 'Timeout': return { _tag: 'Timeout', body: wire(x.body), ms: x.ms };
    }
    throw new TypeError('not a workflow operation');
  };
  const threw = (err) => stringify({
    kind: 'threw',
    name: String(err && err.name ? err.name : 'Error'),
    message: String(err && err.message !== undefined ? err.message : err),
  });
  const realmError = (name, message) => { const e = new Error(message); e.name = name; return e; };

  const step = (kind, id, payload) => {
    if (kind === 'start') {
      const fn = fns.get(id);
      if (!fn) return threw(new Error('unknown branch ' + id));
      const gid = nextGen++;
      gens.set(gid, fn());
      return stringify({ kind: 'started', id: gid });
    }
    const gen = gens.get(id);
    if (!gen) return threw(new Error('unknown or finished branch ' + id));
    try {
      const failure = kind === 'throw' ? parse(payload) : undefined;
      const r = failure ? gen.throw(realmError(failure.name, failure.message)) : gen.next(parse(payload));
      if (r.done) {
        gens.delete(id);
        return stringify({ kind: 'done', value: r.value === undefined ? null : r.value });
      }
      if (!isOp(r.value)) {
        gens.delete(id);
        return threw(new TypeError('yield* expects an operation such as agent(...) or all(...)'));
      }
      return stringify({ kind: 'op', op: wire(r.value) });
    } catch (err) {
      gens.delete(id);
      return threw(err);
    }
  };
  let mainTaken = false;
  const registerMain = (fn) => {
    if (mainTaken || !isGenFn(fn)) throw new Error('main already registered');
    mainTaken = true;
    const id = nextFn++;
    fns.set(id, fn);
    return id;
  };
  return [step, registerMain];
})()
`;

export interface Realm {
  /** Instantiate a branch's generator; returns its generator id. */
  readonly start: (fn: number) => Effect.Effect<number, ScriptFault>;
  /** Resume a generator with a value, or throw a failure into it. */
  readonly resume: (
    id: number,
    input:
      | { readonly kind: 'next'; readonly value: unknown }
      | {
          readonly kind: 'throw';
          readonly name: string;
          readonly message: string;
        },
  ) => Effect.Effect<Exclude<StepReply, { kind: 'started' }>, ScriptFault>;
  /** The script body's branch id. */
  readonly main: number;
}

export interface RealmOptions {
  /** CPU budget for guest code between two yields. */
  readonly stepBudgetMs: number;
}

/**
 * Open a realm over a script body. Every QuickJS resource is owned by the
 * caller's scope, so however the run ends the realm is disposed after it.
 */
export const openRealm = (
  body: string,
  options: RealmOptions,
): Effect.Effect<Realm, ScriptFault, Scope.Scope> =>
  Effect.gen(function* () {
    const quickJs = yield* Effect.tryPromise({
      try: () => getQuickJs(),
      catch: (cause) =>
        new ScriptFault({
          message: `QuickJS failed to load: ${String(cause)}`,
        }),
    });
    let deadline = Number.POSITIVE_INFINITY;
    let budgetExceeded = false;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        quickJs.newRuntime({
          memoryLimitBytes: 64 * 1024 * 1024,
          maxStackSizeBytes: 1024 * 1024,
          interruptHandler: () => {
            if (performance.now() < deadline) return false;
            budgetExceeded = true;
            return true;
          },
        }),
      ),
      (runtime) => Effect.sync(() => runtime.dispose()),
    );
    const context = yield* Effect.acquireRelease(
      Effect.sync(() => runtime.newContext()),
      (context) => Effect.sync(() => context.dispose()),
    );

    const evaluate = (source: string, filename: string): QuickJSHandle =>
      context.unwrapResult(
        context.evalCode(source, filename, { type: 'global', strict: true }),
      );

    const [stepFn, registerMain] = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          evaluate(GUARD_PRELUDE, 'workflow-guards.js').dispose();
          const pair = evaluate(PROTOCOL_PRELUDE, 'workflow-protocol.js');
          const step = context.getProp(pair, 0);
          const register = context.getProp(pair, 1);
          pair.dispose();
          return [step, register] as const;
        },
        catch: (cause) =>
          new ScriptFault({
            message: `Protocol prelude failed: ${describe(context, cause)}`,
          }),
      }),
      ([step, register]) =>
        Effect.sync(() => {
          step.dispose();
          register.dispose();
        }),
    );

    // A body that still uses the async format is the most likely model
    // mistake, so it gets a pointed message instead of a bare syntax error.
    const main = yield* Effect.try({
      try: () => {
        const fn = evaluate(
          `(function* () {\n'use strict';\n${body}\n})`,
          'workflow.js',
        );
        try {
          const id = context.unwrapResult(
            context.callFunction(registerMain, context.undefined, fn),
          );
          const value = context.getNumber(id);
          id.dispose();
          return value;
        } finally {
          fn.dispose();
        }
      },
      catch: (cause) => {
        const message = describe(context, cause);
        return new ScriptFault({
          message: /\bawait\b/.test(body)
            ? `Workflow script syntax error: ${message}. Scripts are generators: write \`yield* agent(...)\`, not \`await agent(...)\`.`
            : `Workflow script syntax error: ${message}`,
        });
      },
    });

    const call = (
      kind: 'start' | 'next' | 'throw',
      id: number,
      payload: string,
    ): Effect.Effect<StepReply, ScriptFault> =>
      Effect.try({
        try: () => {
          const args = [
            context.newString(kind),
            context.newNumber(id),
            context.newString(payload),
          ];
          budgetExceeded = false;
          deadline = performance.now() + options.stepBudgetMs;
          try {
            const result = context.callFunction(
              stepFn,
              context.undefined,
              ...args,
            );
            deadline = Number.POSITIVE_INFINITY;
            const handle = context.unwrapResult(result);
            const text = context.getString(handle);
            handle.dispose();
            return StepReplySchema.parse(JSON.parse(text));
          } finally {
            deadline = Number.POSITIVE_INFINITY;
            for (const arg of args) arg.dispose();
          }
        },
        catch: (cause) =>
          new ScriptFault({
            message: budgetExceeded
              ? `Workflow script exceeded its ${options.stepBudgetMs}ms CPU budget between two operations.`
              : `Workflow step failed: ${describe(context, cause)}`,
          }),
      });

    return {
      main,
      start: (fn) =>
        call('start', fn, 'null').pipe(
          Effect.flatMap((reply) =>
            reply.kind === 'started'
              ? Effect.succeed(reply.id)
              : Effect.fail(
                  new ScriptFault({ message: `Branch ${fn} could not start` }),
                ),
          ),
        ),
      resume: (id, input) =>
        call(
          input.kind,
          id,
          JSON.stringify(
            input.kind === 'next'
              ? (input.value ?? null)
              : { name: input.name, message: input.message },
          ),
        ).pipe(
          Effect.flatMap((reply) =>
            reply.kind === 'started'
              ? Effect.fail(
                  new ScriptFault({ message: 'unexpected start reply' }),
                )
              : Effect.succeed(reply),
          ),
        ),
    } satisfies Realm;
  });

function describe(context: QuickJSContext, cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause)
    return String((cause as { message: unknown }).message);
  void context;
  return String(cause);
}
