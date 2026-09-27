// Third-party imports
import quickJsReleaseVariant from '@jitl/quickjs-wasmfile-release-sync';
import quickJsWasm from '@jitl/quickjs-wasmfile-release-sync/wasm';
import {
  type QuickJSContext,
  type QuickJSHandle,
  type VmFunctionImplementation,
  memoizePromiseFactory,
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from 'quickjs-emscripten-core';
import { Effect, Result, type Scope } from 'effect';
import { z } from 'zod';

// Local imports - utilities
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

export interface SandboxHostBridge {
  /** Sync primitives. Arguments cross as JSON text; results are primitives. */
  syncFns: Record<string, (args: unknown[]) => string | undefined>;
  /** JSON payload for the `args` global; undefined installs `args` as undefined. */
  argsJson: string | undefined;
  /** JSON payload for the immutable, role-separated `files` global. */
  filesJson: string;
}

export interface SandboxOptions {
  filename: string;
  /**
   * Polled by QuickJS while guest code runs. Returning true preempts the
   * running step with an error the script cannot catch.
   */
  shouldInterrupt: () => boolean;
}

const QUICKJS_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const QUICKJS_STACK_LIMIT_BYTES = 1 * 1024 * 1024;
const MAX_FANOUT = 512;

const getQuickJsModule = memoizePromiseFactory(() =>
  newQuickJSWASMModuleFromVariant(
    newVariant(quickJsReleaseVariant, {
      // Every supported host bundles this import with esbuild's binary loader.
      // Supplying bytes avoids all import.meta.url, ASAR, and extension-CJS
      // path resolution at runtime.
      wasmBinary: Uint8Array.from(quickJsWasm).buffer,
    }),
  ),
);

/**
 * One operation a script yields, as it crosses the realm boundary. A branch
 * with several steps crosses as the id of a generator function the realm
 * keeps in its own table; the host only ever asks the realm to step it.
 */
export type WorkflowOperation =
  | { readonly _tag: 'Branch'; readonly branch: number }
  | {
      readonly _tag: 'Agent';
      readonly prompt: string;
      readonly options?: unknown;
    }
  | {
      readonly _tag: 'All';
      readonly items: readonly WorkflowOperation[];
      readonly concurrency: number | null;
    }
  | { readonly _tag: 'Attempt'; readonly body: WorkflowOperation }
  | {
      readonly _tag: 'Retry';
      readonly body: WorkflowOperation;
      readonly times: number | null;
    }
  | {
      readonly _tag: 'Timeout';
      readonly body: WorkflowOperation;
      readonly ms: number;
    };

const WorkflowOperationSchema: z.ZodType<WorkflowOperation> = z.lazy(() =>
  z.discriminatedUnion('_tag', [
    z.object({ _tag: z.literal('Branch'), branch: z.int().nonnegative() }),
    z.object({
      _tag: z.literal('Agent'),
      prompt: z
        .string({
          error: 'agent(prompt, options?) requires a non-empty string prompt.',
        })
        .refine(
          (prompt) => prompt.trim().length > 0,
          'agent(prompt, options?) requires a non-empty string prompt.',
        ),
      options: z.unknown().optional(),
    }),
    z.object({
      _tag: z.literal('All'),
      items: z
        .array(WorkflowOperationSchema)
        .max(MAX_FANOUT, `all() accepts at most ${MAX_FANOUT} items.`),
      concurrency: z
        .int({
          error: 'all() option "concurrency" must be a positive integer.',
        })
        .positive('all() option "concurrency" must be a positive integer.')
        .nullable(),
    }),
    z.object({ _tag: z.literal('Attempt'), body: WorkflowOperationSchema }),
    z.object({
      _tag: z.literal('Retry'),
      body: WorkflowOperationSchema,
      times: z
        .int({
          error: 'retry() option "times" must be an integer from 0 to 10.',
        })
        .min(0, 'retry() option "times" must be an integer from 0 to 10.')
        .max(10, 'retry() option "times" must be an integer from 0 to 10.')
        .nullable(),
    }),
    z.object({
      _tag: z.literal('Timeout'),
      body: WorkflowOperationSchema,
      ms: z
        .int({ error: 'timeout(body, ms) requires a positive integer ms.' })
        .positive('timeout(body, ms) requires a positive integer ms.'),
    }),
  ]),
);

/** What one step of a generator reports back to the host. */
const RealmReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), generator: z.int().nonnegative() }),
  z.object({ kind: z.literal('op'), op: WorkflowOperationSchema }),
  z.object({ kind: z.literal('done'), value: z.unknown().optional() }),
  z.object({
    kind: z.literal('threw'),
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  }),
]);
type RealmReply = z.infer<typeof RealmReplySchema>;
export type BranchStep = Exclude<RealmReply, { kind: 'started' }>;

/** How the host resumes a generator: with a value, or a failure to throw. */
export type BranchInput =
  | { readonly kind: 'next'; readonly value: unknown }
  | {
      readonly kind: 'throw';
      readonly name: string;
      readonly message: string;
    };

/**
 * A realm holding one script. Guest code runs only inside a step: a
 * synchronous call into the realm that runs a generator to its next yield.
 */
export interface WorkflowRealm {
  /** The script body's branch id. */
  readonly main: number;
  /** Instantiate a branch's generator; succeeds with its generator id. */
  readonly start: (branch: number) => Effect.Effect<number, Error>;
  /** Resume a generator to its next operation, its result, or its throw. */
  readonly resume: (
    generator: number,
    input: BranchInput,
  ) => Effect.Effect<BranchStep, Error>;
}

/**
 * Nondeterminism and dynamic-code guards. Journal replay requires stable call
 * order, while workflow scripts have no reason to compile source at runtime.
 */
const DETERMINISM_PRELUDE = `
'use strict';
(() => {
  const guard = (what, hint) =>
    function () {
      throw new Error(
        what + ' is unavailable in workflow scripts (breaks resume); ' + hint,
      );
    };
  Object.defineProperty(Math, 'random', {
    value: guard('Math.random()', 'vary prompts by call index instead.'),
    writable: false,
    configurable: false,
  });

  const RealDate = Date;
  function GuardedDate(...args) {
    if (args.length === 0) {
      throw new Error(
        'new Date() without arguments is unavailable in workflow scripts (breaks resume); pass timestamps in via args.',
      );
    }
    const instance = Reflect.construct(RealDate, args);
    return new.target ? instance : String(instance);
  }
  GuardedDate.prototype = RealDate.prototype;
  GuardedDate.parse = RealDate.parse;
  GuardedDate.UTC = RealDate.UTC;
  Object.defineProperty(GuardedDate, 'now', {
    value: guard('Date.now()', 'pass timestamps in via args.'),
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
    throw new TypeError('Dynamic code generation is disallowed in workflow scripts.');
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

/**
 * The script-facing vocabulary and the step machine. It captures the opaque
 * sync dispatcher, deletes its temporary globals, and defines the operation
 * constructors: `agent`, `all`, `forEach`, `attempt`, `retry` and `timeout`
 * build frozen values that run nothing, and `yield*` hands one to the host.
 *
 * The expression evaluates to `bind(main)`, which registers the script body
 * as branch 0 and returns `step`, the one function the host ever calls. Both
 * stay host-side handles, never globals. The host never calls a method on a
 * guest object and never hands the realm a host function beyond the sync
 * dispatcher, so every callback and value a script can reach is realm-local
 * and codegen-gated; only JSON text crosses, in both directions.
 */
const PROTOCOL_PRELUDE = `
'use strict';
(() => {
  const hostSync = globalThis.__wfHostSync;
  const config = JSON.parse(globalThis.__wfBridgeConfig);
  delete globalThis.__wfHostSync;
  delete globalThis.__wfBridgeConfig;

  const parseJson = JSON.parse;
  const stringifyJson = JSON.stringify;
  const freeze = Object.freeze;
  const isArray = Array.isArray;
  const getPrototypeOf = Object.getPrototypeOf;
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, {
      value,
      writable: false,
      configurable: false,
    });
  const toRealmError = (err) => {
    const message =
      err && typeof err === 'object' && 'message' in err
        ? String(err.message)
        : String(err);
    const realmError = new Error(message);
    if (err && typeof err === 'object' && 'name' in err && err.name) {
      realmError.name = String(err.name);
    }
    return realmError;
  };

  for (const name of config.syncNames) {
    define(name, function (...args) {
      try {
        return hostSync(name, stringifyJson(args));
      } catch (err) {
        throw toRealmError(err);
      }
    });
  }
  define('args', config.argsJson === undefined ? undefined : parseJson(config.argsJson));
  const files = parseJson(config.filesJson);
  Object.values(files).forEach(freeze);
  define('files', freeze(files));

  const OP = Symbol('workflow.operation');
  const GeneratorFunction = getPrototypeOf(function* () {});
  const isStartedGenerator = (value) =>
    value !== null &&
    typeof value === 'object' &&
    getPrototypeOf(getPrototypeOf(value)) === GeneratorFunction.prototype;
  const isBranch = (value) =>
    typeof value === 'function' && getPrototypeOf(value) === GeneratorFunction;
  const isOperation = (value) =>
    value !== null && typeof value === 'object' && typeof value[OP] === 'string';
  const operation = (tag, fields) => {
    const op = {
      [OP]: tag,
      ...fields,
      // yield* op: yield the op to the host, then evaluate to its result.
      *[Symbol.iterator]() {
        return yield op;
      },
    };
    return freeze(op);
  };
  const body = (value, where) => {
    if (isOperation(value) || isBranch(value)) return value;
    if (isStartedGenerator(value)) {
      throw new TypeError(
        where + ' is a started generator; pass the generator function itself (fn, not fn()).',
      );
    }
    throw new TypeError(
      where + ' expects an operation such as agent(...), or a generator function (function* () { ... }).',
    );
  };
  const all = (items, options) => {
    if (!isArray(items)) throw new TypeError('all(items) expects an array of operations.');
    const checked = items.map((item, i) => body(item, 'all() item ' + i));
    return operation('All', { items: freeze(checked), concurrency: options?.concurrency ?? null });
  };
  define('agent', (prompt, options) => operation('Agent', { prompt, options }));
  define('all', all);
  define('forEach', (items, fn, options) => {
    if (!isArray(items)) throw new TypeError('forEach(items, fn) expects an array.');
    if (typeof fn !== 'function') {
      throw new TypeError('forEach(items, fn) expects a function that returns an operation.');
    }
    return all(items.map(fn), options);
  });
  define('attempt', (value) => operation('Attempt', { body: body(value, 'attempt()') }));
  define('retry', (value, options) =>
    operation('Retry', { body: body(value, 'retry()'), times: options?.times ?? null }));
  define('timeout', (value, ms) => operation('Timeout', { body: body(value, 'timeout()'), ms }));

  const branches = new Map();
  const generators = new Map();
  let nextBranch = 0;
  let nextGenerator = 0;
  const wire = (value) => {
    if (isBranch(value)) {
      const branch = nextBranch++;
      branches.set(branch, value);
      return { _tag: 'Branch', branch };
    }
    switch (value[OP]) {
      case 'Agent':
        return { _tag: 'Agent', prompt: value.prompt, options: value.options };
      case 'All':
        return { _tag: 'All', items: value.items.map(wire), concurrency: value.concurrency };
      case 'Attempt':
        return { _tag: 'Attempt', body: wire(value.body) };
      case 'Retry':
        return { _tag: 'Retry', body: wire(value.body), times: value.times };
      case 'Timeout':
        return { _tag: 'Timeout', body: wire(value.body), ms: value.ms };
    }
    throw new TypeError('not a workflow operation');
  };
  const serialize = (reply) => {
    try {
      return stringifyJson(reply);
    } catch (err) {
      throw new TypeError(
        'Workflow value is not JSON-serializable: ' + toRealmError(err).message,
      );
    }
  };
  const report = (result) => {
    if (result.done) return serialize({ kind: 'done', value: result.value });
    if (!isOperation(result.value)) {
      throw new TypeError(
        'yield* expects an operation such as agent(...) or all(...); write yield* before the operation.',
      );
    }
    return serialize({ kind: 'op', op: wire(result.value) });
  };
  const threw = (err) =>
    stringifyJson({
      kind: 'threw',
      name: err && typeof err === 'object' && err.name ? String(err.name) : 'Error',
      message:
        err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err),
      stack: err && typeof err === 'object' && err.stack ? String(err.stack) : undefined,
    });

  const step = (kind, id, payload) => {
    try {
      if (kind === 'start') {
        const branch = branches.get(id);
        if (branch === undefined) throw new Error('Unknown workflow branch ' + id + '.');
        const generator = nextGenerator++;
        generators.set(generator, branch());
        return stringifyJson({ kind: 'started', generator });
      }
      const generator = generators.get(id);
      if (generator === undefined) throw new Error('Unknown workflow generator ' + id + '.');
      try {
        let result;
        if (kind === 'throw') {
          const failure = parseJson(payload);
          const error = new Error(failure.message);
          error.name = failure.name;
          result = generator.throw(error);
        } else {
          result = generator.next(payload === '' ? undefined : parseJson(payload));
        }
        const text = report(result);
        if (result.done) generators.delete(id);
        return text;
      } catch (err) {
        generators.delete(id);
        throw err;
      }
    } catch (err) {
      return threw(err);
    }
  };

  return (main) => {
    if (nextBranch !== 0 || !isBranch(main)) throw new Error('The workflow body is already bound.');
    branches.set(nextBranch++, main);
    return step;
  };
})()
`;

const loadQuickJsModule = Effect.tryPromise({
  try: () => getQuickJsModule(),
  catch: ensureError,
});

/**
 * Opens a fresh QuickJS runtime over one workflow body. The WASM module is
 * shared, but every script receives a new runtime and context with
 * independent interrupt, heap, stack, and handle ownership.
 *
 * Every QuickJS resource belongs to the caller's scope, so however the run
 * ends the realm is disposed after it. There are no promises in the realm
 * and so no job queue to pump: guest code runs only inside a step, and a step
 * that never yields is preempted by the interrupt handler.
 */
export function openWorkflowRealm(
  body: string,
  bridge: SandboxHostBridge,
  options: SandboxOptions,
): Effect.Effect<WorkflowRealm, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const quickJs = yield* loadQuickJsModule;
    const runtime = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          quickJs.newRuntime({
            memoryLimitBytes: QUICKJS_MEMORY_LIMIT_BYTES,
            maxStackSizeBytes: QUICKJS_STACK_LIMIT_BYTES,
            interruptHandler: options.shouldInterrupt,
          }),
        catch: ensureError,
      }),
      (runtime) => Effect.sync(() => runtime.dispose()),
    );
    const context = yield* Effect.acquireRelease(
      Effect.try({ try: () => runtime.newContext(), catch: ensureError }),
      (context) => Effect.sync(() => context.dispose()),
    );
    const disposeHandle = (handle: QuickJSHandle) =>
      Effect.sync(() => handle.dispose());

    const bind = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          installHostBridge(context, bridge);
          const handle = evaluate(
            context,
            PROTOCOL_PRELUDE,
            'workflow-protocol.js',
          );
          evaluate(
            context,
            DETERMINISM_PRELUDE,
            'workflow-prelude.js',
          ).dispose();
          return handle;
        },
        catch: ensureError,
      }),
      disposeHandle,
    );
    const main = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          evaluate(
            context,
            `(function* () {\n'use strict';\n${body}\n})`,
            options.filename,
          ),
        catch: (error) =>
          new Error(`Workflow script syntax error: ${toErrorMessage(error)}`),
      }),
      disposeHandle,
    );
    const step = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          context.unwrapResult(
            context.callFunction(bind, context.undefined, main),
          ),
        catch: ensureError,
      }),
      disposeHandle,
    );

    const call = (
      kind: 'start' | 'next' | 'throw',
      id: number,
      payload: string,
    ): Effect.Effect<RealmReply, Error> =>
      Effect.try({
        try: () => {
          const args = [
            context.newString(kind),
            context.newNumber(id),
            context.newString(payload),
          ];
          try {
            const handle = context.unwrapResult(
              context.callFunction(step, context.undefined, ...args),
            );
            try {
              return JSON.parse(context.getString(handle)) as unknown;
            } finally {
              handle.dispose();
            }
          } finally {
            for (const arg of args) arg.dispose();
          }
        },
        catch: (error) =>
          new Error(`Workflow script step failed: ${toErrorMessage(error)}`),
      }).pipe(
        Effect.flatMap((raw) => {
          const reply = RealmReplySchema.safeParse(raw);
          return reply.success
            ? Effect.succeed(reply.data)
            : Effect.fail(
                new Error(
                  `Workflow script yielded an invalid operation: ${z.prettifyError(reply.error)}`,
                ),
              );
        }),
      );

    return {
      main: 0,
      start: (branch) =>
        call('start', branch, '').pipe(
          Effect.flatMap((reply) =>
            reply.kind === 'started'
              ? Effect.succeed(reply.generator)
              : Effect.fail(
                  new Error(
                    `Workflow branch ${branch} could not start: ${reply.kind === 'threw' ? reply.message : reply.kind}`,
                  ),
                ),
          ),
        ),
      resume: (generator, input) =>
        call(
          input.kind,
          generator,
          input.kind === 'throw'
            ? JSON.stringify({ name: input.name, message: input.message })
            : // An undefined value crosses as '' and resumes as undefined.
              (JSON.stringify(input.value) ?? ''),
        ).pipe(
          Effect.flatMap((reply) =>
            reply.kind === 'started'
              ? Effect.fail(
                  new Error(
                    'Workflow generator replied to a resume as a start.',
                  ),
                )
              : Effect.succeed(reply),
          ),
        ),
    } satisfies WorkflowRealm;
  });
}

function installHostBridge(
  context: QuickJSContext,
  bridge: SandboxHostBridge,
): void {
  const parseArgs = (json: string): unknown[] => {
    const parsed = Result.getOrThrow(
      Result.try({
        try: () => JSON.parse(json) as unknown,
        catch: (error) =>
          new Error(
            `Workflow bridge received malformed argument JSON: ${toErrorMessage(error)}`,
          ),
      }),
    );
    if (!Array.isArray(parsed)) {
      throw new Error('Workflow bridge arguments must decode to an array.');
    }
    return parsed;
  };

  defineHostGlobal(context, '__wfHostSync', (nameHandle, argsHandle) => {
    const name = context.getString(nameHandle);
    const argsJson = context.getString(argsHandle);
    const fn = bridge.syncFns[name];
    if (!fn) throw new Error(`Unknown workflow sync primitive: ${name}`);
    const result = fn(parseArgs(argsJson));
    return result === undefined ? context.undefined : context.newString(result);
  });

  const config = context.newString(
    JSON.stringify({
      syncNames: Object.keys(bridge.syncFns),
      argsJson: bridge.argsJson,
      filesJson: bridge.filesJson,
    }),
  );
  context.setProp(context.global, '__wfBridgeConfig', config);
  config.dispose();
}

function defineHostGlobal(
  context: QuickJSContext,
  name: string,
  fn: VmFunctionImplementation<QuickJSHandle>,
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
