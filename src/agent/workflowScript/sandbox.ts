// Third-party imports
import quickJsReleaseVariant from '@jitl/quickjs-wasmfile-release-sync';
import quickJsWasm from '@jitl/quickjs-wasmfile-release-sync/wasm';
import {
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type VmFunctionImplementation,
  memoizePromiseFactory,
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from 'quickjs-emscripten-core';
import { Cause, Effect, Exit, FiberSet, Latch, Result } from 'effect';
import { z } from 'zod';

// Local imports - utilities
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { DETERMINISM_PRELUDE } from './realmPreludes';

export interface SandboxHostBridge<R = never> {
  /**
   * Async primitives. Arguments and results cross as JSON text only. Each call
   * is a sandbox-owned fiber, interrupted before its realm is disposed.
   */
  asyncFns: Record<
    string,
    (args: unknown[]) => Effect.Effect<string | undefined, Error, R>
  >;
  /** Sync primitives. Arguments cross as JSON text; results are primitives. */
  syncFns: Record<string, (args: unknown[]) => string | undefined>;
  /** JSON payload for the `args` global; undefined installs `args` as undefined. */
  argsJson: string | undefined;
  /** JSON payload for the immutable, role-separated `files` global. */
  filesJson: string;
  /** Trusted realm-side orchestration primitives installed before the body. */
  realmPrelude: string;
}

export interface SandboxOptions {
  /** Wall-clock cap for the whole (async) script run. */
  timeoutMs: number;
  /** Guest CPU budget; defaults to {@link GUEST_CPU_BUDGET_MS}. */
  cpuBudgetMs?: number;
  filename: string;
}

const QUICKJS_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const QUICKJS_STACK_LIMIT_BYTES = 1 * 1024 * 1024;
/**
 * Total time guest code may spend executing, apart from the wall clock.
 * Orchestration is cheap between awaits, so this budget stops a synchronous
 * runaway loop long before a multi-hour wall clock would, while time spent
 * waiting on agent() calls never counts against it.
 */
const GUEST_CPU_BUDGET_MS = 60_000;
const MAX_JOBS_PER_TURN = 100;

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
 * Captures the three opaque host dispatchers, deletes their temporary globals,
 * and installs realm-local wrappers. Only names and JSON strings reach those
 * dispatchers; guest arrays, objects, functions, and promises remain in QuickJS.
 * The expression evaluates to the private realm-local result-delivery function.
 */
const BRIDGE_PRELUDE = `
'use strict';
(() => {
  const hostAsync = globalThis.__wfHostAsync;
  const hostSync = globalThis.__wfHostSync;
  const hostDeliver = globalThis.__wfHostDeliver;
  const config = JSON.parse(globalThis.__wfBridgeConfig);
  delete globalThis.__wfHostAsync;
  delete globalThis.__wfHostSync;
  delete globalThis.__wfHostDeliver;
  delete globalThis.__wfBridgeConfig;

  const parseJson = JSON.parse;
  const stringifyJson = JSON.stringify;
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

  for (const name of config.asyncNames) {
    define(name, function (...args) {
      const pending = (async () => {
        let payload;
        try {
          payload = await hostAsync(name, stringifyJson(args));
        } catch (err) {
          throw toRealmError(err);
        }
        return payload === undefined ? undefined : parseJson(payload);
      })();
      pending.catch(() => {});
      return pending;
    });
  }
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
  Object.values(files).forEach(Object.freeze);
  define('files', Object.freeze(files));

  let delivered = false;
  return function (value, isError) {
    if (delivered) return;
    delivered = true;
    if (isError) {
      const err = toRealmError(value);
      const stack =
        value && typeof value === 'object' && 'stack' in value && value.stack
          ? String(value.stack)
          : undefined;
      hostDeliver(
        undefined,
        stringifyJson({ name: err.name, message: err.message, stack }),
      );
      return;
    }
    let payload;
    try {
      payload = value === undefined ? undefined : (stringifyJson(value) ?? 'null');
    } catch (err) {
      const realmErr = toRealmError(err);
      hostDeliver(
        undefined,
        stringifyJson({
          name: realmErr.name,
          message: 'Workflow result is not JSON-serializable: ' + realmErr.message,
        }),
      );
      return;
    }
    hostDeliver(payload, undefined);
  };
})()
`;

/** What the guest body delivered: its JSON-revived value, or its error. */
type GuestOutcome = Result.Result<unknown, Error>;

/** Error shape the bridge prelude delivers for a rejected guest body. */
const GuestErrorRecordSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});

type SandboxSettlement =
  | { readonly kind: 'outcome'; readonly outcome: GuestOutcome }
  | { readonly kind: 'host-failure'; readonly error: Error }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cpu-exhausted' };

const loadQuickJsModule = Effect.tryPromise({
  try: () => getQuickJsModule(),
  catch: ensureError,
});

/**
 * Evaluates a workflow body in a fresh preemptible QuickJS runtime. The WASM
 * module is shared, but every script receives a new runtime and context with
 * independent interrupt, heap, stack, promise-job, and handle ownership.
 *
 * The run is one scoped Effect. The runtime, the context, the pending host
 * promises, the host-call fibers and the deadline timer belong to its scope,
 * so however the run ends (result, fault, timeout, or the caller interrupting
 * it) the host calls are interrupted first and the realm is disposed after.
 * Guest code that never yields is preempted by the QuickJS interrupt handler
 * at the deadline; an interruption lands at the pump's next yield.
 */
export function runScriptInSandbox<R = never>(
  body: string,
  bridge: SandboxHostBridge<R>,
  options: SandboxOptions,
): Effect.Effect<unknown, Error, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const quickJs = yield* loadQuickJsModule;
      const deadline = performance.now() + options.timeoutMs;
      const wakeLatch = yield* Latch.make(false);
      let interruptRequested = false;
      let settlement: SandboxSettlement | undefined;
      const settled = (): boolean => settlement !== undefined;
      const wake = (): void => {
        wakeLatch.openUnsafe();
      };
      const settle = (next: SandboxSettlement): void => {
        settlement ??= next;
        wake();
      };
      const markTimedOut = (): void => {
        interruptRequested = true;
        settle({ kind: 'timeout' });
      };
      // Guest CPU: time spent inside guest-executing calls, accumulated
      // across slices; the interrupt handler reads the open slice.
      const cpuBudgetMs = options.cpuBudgetMs ?? GUEST_CPU_BUDGET_MS;
      let guestCpuMs = 0;
      let sliceStartedAt: number | undefined;
      const inGuestSlice = <A>(execute: () => A): A => {
        sliceStartedAt = performance.now();
        try {
          return execute();
        } finally {
          guestCpuMs += performance.now() - sliceStartedAt;
          sliceStartedAt = undefined;
        }
      };

      const runtime = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            quickJs.newRuntime({
              memoryLimitBytes: QUICKJS_MEMORY_LIMIT_BYTES,
              maxStackSizeBytes: QUICKJS_STACK_LIMIT_BYTES,
              interruptHandler: () => {
                const now = performance.now();
                if (interruptRequested || now >= deadline) {
                  markTimedOut();
                  return true;
                }
                if (
                  sliceStartedAt !== undefined &&
                  guestCpuMs + (now - sliceStartedAt) >= cpuBudgetMs
                ) {
                  interruptRequested = true;
                  settle({ kind: 'cpu-exhausted' });
                  return true;
                }
                return false;
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
      const hostCalls = yield* FiberSet.make<void>();
      const forkHostCall = yield* FiberSet.runtime(hostCalls)<R>();
      const pendingHostPromises = new Set<QuickJSDeferredPromise>();
      let active = true;
      // Released before the host calls are interrupted: a call ending under
      // that interrupt must not settle into a realm being torn down.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          active = false;
          for (const deferred of pendingHostPromises) {
            if (deferred.alive) deferred.dispose();
          }
          pendingHostPromises.clear();
        }),
      );
      yield* Effect.sync(markTimedOut).pipe(
        Effect.delay(options.timeoutMs),
        Effect.forkScoped,
      );

      const run = Effect.gen(function* () {
        const deliver = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              installHostBridge(context, bridge, {
                pending: pendingHostPromises,
                isActive: () => active,
                fork: (call) => {
                  forkHostCall(call);
                },
                fail: (error) => settle({ kind: 'host-failure', error }),
                deliver: (outcome) => settle({ kind: 'outcome', outcome }),
                wake,
              });
              return evaluate(context, BRIDGE_PRELUDE, 'workflow-bridge.js');
            },
            catch: ensureError,
          }),
          (handle) => Effect.sync(() => handle.dispose()),
        );
        yield* Effect.try({
          try: () => {
            evaluateAndDispose(
              context,
              DETERMINISM_PRELUDE,
              'workflow-prelude.js',
            );
            evaluateAndDispose(
              context,
              bridge.realmPrelude,
              'workflow-orchestration.js',
            );
          },
          catch: ensureError,
        });
        const bodyThunk = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              evaluate(
                context,
                `(async () => {\n'use strict';\n${body}\n})`,
                options.filename,
              ),
            catch: (error) =>
              new Error(
                `Workflow script syntax error: ${toErrorMessage(error)}`,
              ),
          }),
          (handle) => Effect.sync(() => handle.dispose()),
        );
        yield* Effect.try({
          try: () => {
            setGlobal(context, '__wfBody', bodyThunk);
            setGlobal(context, '__wfDeliver', deliver);
            inGuestSlice(() =>
              evaluateAndDispose(
                context,
                `(() => {
  const body = globalThis.__wfBody;
  const deliver = globalThis.__wfDeliver;
  delete globalThis.__wfBody;
  delete globalThis.__wfDeliver;
  body().then(
    (value) => deliver(value, false),
    (error) => deliver(error, true),
  );
})()`,
                'workflow-kickoff.js',
              ),
            );
          },
          catch: ensureError,
        });

        while (!settled()) {
          const executed = yield* Effect.try({
            try: () => {
              const result = inGuestSlice(() =>
                runtime.executePendingJobs(MAX_JOBS_PER_TURN),
              );
              // Result delivery is the run's linearization point. A later
              // guest job in the same QuickJS batch must not replace that
              // result with its own error.
              if (settled()) {
                result.dispose();
                return 0;
              }
              return result.unwrap();
            },
            catch: ensureError,
          });
          if (settled()) break;
          if (executed === MAX_JOBS_PER_TURN || runtime.hasPendingJob()) {
            // Give host calls, sibling runtimes, and the timer a turn: the
            // scheduler dispatches through a macrotask.
            yield* Effect.yieldNow;
            continue;
          }
          // Close, then re-check: a wake that landed since the last batch
          // either settled the run or queued a job.
          wakeLatch.closeUnsafe();
          if (settled() || runtime.hasPendingJob()) continue;
          yield* wakeLatch.await;
        }

        switch (settlement?.kind) {
          case 'outcome':
            return yield* Effect.fromResult(settlement.outcome);
          case 'host-failure':
            return yield* Effect.fail(settlement.error);
          case 'timeout':
            return yield* Effect.fail(timeoutError(options));
          case 'cpu-exhausted':
            return yield* Effect.fail(cpuExhaustedError(options));
          case undefined:
            return yield* Effect.fail(
              new Error('Workflow sandbox stopped without a result.'),
            );
        }
      });
      // A step the deadline or the CPU budget interrupted fails with QuickJS's
      // own interrupt error; the run's outcome is the limit it hit.
      return yield* run.pipe(
        Effect.mapError((error) => {
          switch (settlement?.kind) {
            case 'timeout':
              return timeoutError(options);
            case 'cpu-exhausted':
              return cpuExhaustedError(options);
            default:
              return error;
          }
        }),
      );
    }),
  );
}

interface HostBridgePorts<R> {
  readonly pending: Set<QuickJSDeferredPromise>;
  readonly isActive: () => boolean;
  /**
   * Start one host call as a sandbox-owned fiber. It starts synchronously,
   * inside the guest's call, so its host-side effects keep guest order.
   */
  readonly fork: (call: Effect.Effect<void, never, R>) => void;
  readonly fail: (error: Error) => void;
  readonly deliver: (outcome: GuestOutcome) => void;
  readonly wake: () => void;
}

function installHostBridge<R>(
  context: QuickJSContext,
  bridge: SandboxHostBridge<R>,
  ports: HostBridgePorts<R>,
): void {
  const { pending, isActive, fork, fail, deliver, wake } = ports;
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

  const settleHostPromise = (
    deferred: QuickJSDeferredPromise,
    exit: Exit.Exit<string | undefined, Error>,
  ): void => {
    pending.delete(deferred);
    if (!isActive() || !deferred.alive) {
      wake();
      return;
    }
    const settledPromise = Result.try({
      try: () => {
        const handle = Exit.match(exit, {
          onSuccess: (payload) =>
            payload === undefined ? undefined : context.newString(payload),
          onFailure: (cause) =>
            context.newError(toErrorRecord(Cause.squash(cause))),
        });
        if (handle === undefined) return deferred.resolve();
        try {
          if (Exit.isSuccess(exit)) deferred.resolve(handle);
          else deferred.reject(handle);
        } finally {
          handle.dispose();
        }
      },
      catch: ensureError,
    });
    if (Result.isFailure(settledPromise)) {
      if (deferred.alive) deferred.dispose();
      fail(settledPromise.failure);
    }
    wake();
  };

  defineHostGlobal(context, '__wfHostAsync', (nameHandle, argsHandle) => {
    const name = context.getString(nameHandle);
    const argsJson = context.getString(argsHandle);
    const fn = bridge.asyncFns[name];
    if (!fn) throw new Error(`Unknown workflow async primitive: ${name}`);
    const args = parseArgs(argsJson);

    const deferred = context.newPromise();
    pending.add(deferred);
    fork(
      Effect.suspend(() => fn(args)).pipe(
        Effect.exit,
        // Settle on a later scheduler turn, never from inside this host
        // function: a call that finished synchronously would otherwise
        // resolve its promise before the guest holds it.
        Effect.tap(() => Effect.yieldNow),
        Effect.flatMap((exit) =>
          Effect.sync(() => settleHostPromise(deferred, exit)),
        ),
      ),
    );
    return deferred.handle;
  });

  defineHostGlobal(context, '__wfHostSync', (nameHandle, argsHandle) => {
    const name = context.getString(nameHandle);
    const argsJson = context.getString(argsHandle);
    const fn = bridge.syncFns[name];
    if (!fn) throw new Error(`Unknown workflow sync primitive: ${name}`);
    const result = fn(parseArgs(argsJson));
    return result === undefined ? context.undefined : context.newString(result);
  });

  const readOptionalString = (handle: QuickJSHandle): string | undefined =>
    context.typeof(handle) === 'string' ? context.getString(handle) : undefined;

  defineHostGlobal(context, '__wfHostDeliver', (payloadHandle, errorHandle) => {
    deliver(
      parseOutcome(
        readOptionalString(payloadHandle),
        readOptionalString(errorHandle),
      ),
    );
    return context.undefined;
  });

  setGlobalAndDispose(
    context,
    '__wfBridgeConfig',
    context.newString(
      JSON.stringify({
        asyncNames: Object.keys(bridge.asyncFns),
        syncNames: Object.keys(bridge.syncFns),
        argsJson: bridge.argsJson,
        filesJson: bridge.filesJson,
      }),
    ),
  );
}

function defineHostGlobal(
  context: QuickJSContext,
  name: string,
  fn: VmFunctionImplementation<QuickJSHandle>,
): void {
  setGlobalAndDispose(context, name, context.newFunction(name, fn));
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

function evaluateAndDispose(
  context: QuickJSContext,
  source: string,
  filename: string,
): void {
  evaluate(context, source, filename).dispose();
}

function setGlobal(
  context: QuickJSContext,
  name: string,
  value: QuickJSHandle,
): void {
  context.setProp(context.global, name, value);
}

function setGlobalAndDispose(
  context: QuickJSContext,
  name: string,
  value: QuickJSHandle,
): void {
  setGlobal(context, name, value);
  value.dispose();
}

function parseOutcome(payload?: string, errorJson?: string): GuestOutcome {
  if (errorJson !== undefined) {
    const parsed = Result.try({
      try: () => JSON.parse(errorJson) as unknown,
      catch: (error) =>
        new Error(
          `Workflow script returned malformed error JSON: ${toErrorMessage(error)}`,
        ),
    });
    if (Result.isFailure(parsed)) return parsed;
    const decoded = GuestErrorRecordSchema.safeParse(parsed.success);
    if (!decoded.success) {
      return Result.fail(
        new Error(
          'Workflow script returned an invalid error record from the sandbox.',
        ),
      );
    }
    const record = decoded.data;
    // Guest stack frames locate the failure inside the script (the only
    // context a caller has for a sandboxed error), so fold them into the
    // message the tool result carries.
    const frames = (record.stack ?? '')
      .split('\n')
      .filter((line) => line.trim().startsWith('at '))
      .slice(0, 3);
    const error = new Error(
      frames.length > 0
        ? `${record.message}\n${frames.join('\n')}`
        : record.message,
    );
    error.name = record.name;
    return Result.fail(error);
  }
  if (payload === undefined) return Result.succeed(undefined);
  return Result.try({
    try: () => JSON.parse(payload) as unknown,
    catch: (error) =>
      new Error(
        `Workflow script returned malformed result JSON: ${toErrorMessage(error)}`,
      ),
  });
}

function toErrorRecord(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: toErrorMessage(error) };
}

function timeoutError(options: SandboxOptions): Error {
  return new Error(
    `Workflow script ${options.filename} timed out after ${options.timeoutMs}ms`,
  );
}

function cpuExhaustedError(options: SandboxOptions): Error {
  return new Error(
    `Workflow script ${options.filename} used its ${options.cpuBudgetMs ?? GUEST_CPU_BUDGET_MS}ms guest CPU budget; look for a loop that never awaits.`,
  );
}
