// Node imports
import { setImmediate as setImmediateAsync } from 'node:timers/promises';

// Third-party imports
import quickJsReleaseVariant from '@jitl/quickjs-wasmfile-release-sync';
import quickJsWasm from '@jitl/quickjs-wasmfile-release-sync/wasm';
import {
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type VmFunctionImplementation,
  memoizePromiseFactory,
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from 'quickjs-emscripten-core';
import { z } from 'zod';

// Local imports - utilities
import { onAbort } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - workflow scripts
import { WorkflowScriptParseError } from './parseScript';

export interface SandboxHostBridge {
  /** Async primitives. Arguments and results cross as JSON text only. */
  asyncFns: Record<string, (args: unknown[]) => Promise<string | undefined>>;
  /** Sync primitives. Arguments cross as JSON text; results are primitives. */
  syncFns: Record<string, (args: unknown[]) => string | undefined>;
  /** JSON payload for the `args` global; undefined installs `args` as undefined. */
  argsJson: string | undefined;
  /** JSON payload for the immutable, role-separated `files` global. */
  filesJson: string;
  /** Trusted realm-side orchestration primitives installed before the body. */
  realmPreludes?: string[];
}

export interface SandboxOptions {
  /** Wall-clock cap for the whole (async) script run. */
  timeoutMs: number;
  filename: string;
  /** Parent cancellation signal for immediate guest preemption. */
  signal?: AbortSignal;
  /** Fired exactly once when the wall-clock timeout is first observed. */
  onTimeout?: () => void;
}

const QUICKJS_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const QUICKJS_STACK_LIMIT_BYTES = 1 * 1024 * 1024;
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

interface GuestOutcome {
  value?: unknown;
  error?: Error;
}

/** Error shape the bridge prelude delivers for a rejected guest body. */
const GuestErrorRecordSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});

type SandboxSettlement =
  | { readonly kind: 'outcome'; readonly outcome: GuestOutcome }
  | { readonly kind: 'host-failure'; readonly error: Error }
  | { readonly kind: 'aborted'; readonly error: Error }
  | { readonly kind: 'timeout' };

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

/**
 * Evaluates a workflow body in a fresh preemptible QuickJS runtime. The WASM
 * module is shared, but every script receives a new runtime and context with
 * independent interrupt, heap, stack, promise-job, and handle ownership.
 */
export async function runScriptInSandbox(
  body: string,
  bridge: SandboxHostBridge,
  options: SandboxOptions,
): Promise<unknown> {
  if (options.signal?.aborted) throw abortError(options.signal);
  const quickJs = await getQuickJsModule();
  if (options.signal?.aborted) throw abortError(options.signal);
  const deadline = performance.now() + options.timeoutMs;
  let active = true;
  let interruptRequested = false;
  let timeoutNotified = false;
  let settlement: SandboxSettlement | undefined;
  let wakeResolve: (() => void) | undefined;

  const wake = () => {
    const resolve = wakeResolve;
    wakeResolve = undefined;
    resolve?.();
  };
  const waitForWake = () =>
    new Promise<void>((resolve) => {
      wakeResolve = resolve;
      if (settlement !== undefined || runtime.hasPendingJob()) {
        wake();
      }
    });
  const markTimedOut = () => {
    interruptRequested = true;
    if (settlement !== undefined) {
      wake();
      return;
    }
    settlement = { kind: 'timeout' };
    if (!timeoutNotified) {
      timeoutNotified = true;
      try {
        options.onTimeout?.();
      } catch {
        // Timeout settlement must not depend on the caller's abort callback.
      }
    }
    wake();
  };
  const markAborted = () => {
    interruptRequested = true;
    if (settlement === undefined && options.signal) {
      settlement = { kind: 'aborted', error: abortError(options.signal) };
    }
    wake();
  };

  const runtime = quickJs.newRuntime({
    memoryLimitBytes: QUICKJS_MEMORY_LIMIT_BYTES,
    maxStackSizeBytes: QUICKJS_STACK_LIMIT_BYTES,
    interruptHandler: () => {
      if (interruptRequested || performance.now() >= deadline) {
        markTimedOut();
        return true;
      }
      return false;
    },
  });
  let context: QuickJSContext;
  try {
    context = runtime.newContext();
  } catch (error) {
    runtime.dispose();
    throw error;
  }
  const pendingHostPromises = new Set<QuickJSDeferredPromise>();
  const timeout = setTimeout(markTimedOut, options.timeoutMs);
  const detachAbort = onAbort(options.signal, markAborted);

  try {
    installHostBridge(
      context,
      bridge,
      pendingHostPromises,
      () => active,
      (error) => {
        if (settlement !== undefined) return;
        settlement = { kind: 'host-failure', error };
        wake();
      },
      (delivered) => {
        if (settlement !== undefined) return;
        settlement = { kind: 'outcome', outcome: delivered };
        wake();
      },
      wake,
    );

    const deliver = evaluate(context, BRIDGE_PRELUDE, 'workflow-bridge.js');
    try {
      evaluateAndDispose(context, DETERMINISM_PRELUDE, 'workflow-prelude.js');
      for (const prelude of bridge.realmPreludes ?? []) {
        evaluateAndDispose(context, prelude, 'workflow-orchestration.js');
      }

      let bodyThunk: QuickJSHandle;
      try {
        bodyThunk = evaluate(
          context,
          `(async () => {\n'use strict';\n${body}\n})`,
          options.filename,
        );
      } catch (error) {
        throw new WorkflowScriptParseError(
          `Workflow script syntax error: ${toErrorMessage(error)}`,
        );
      }

      try {
        setGlobal(context, '__wfBody', bodyThunk);
        setGlobal(context, '__wfDeliver', deliver);
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
        );
      } finally {
        bodyThunk.dispose();
      }

      await pumpJobs(runtime, () => settlement !== undefined, waitForWake);

      switch (settlement?.kind) {
        case 'outcome':
          if (settlement.outcome.error) throw settlement.outcome.error;
          return settlement.outcome.value;
        case 'host-failure':
        case 'aborted':
          throw settlement.error;
        case 'timeout':
          throw timeoutError(options);
        case undefined:
          throw new Error('Workflow sandbox stopped without a result.');
      }
    } finally {
      deliver.dispose();
    }
  } catch (error) {
    if (settlement?.kind === 'timeout') throw timeoutError(options);
    if (settlement?.kind === 'aborted') throw settlement.error;
    throw error;
  } finally {
    active = false;
    clearTimeout(timeout);
    detachAbort();
    wake();
    try {
      for (const deferred of pendingHostPromises) deferred.dispose();
      pendingHostPromises.clear();
    } finally {
      try {
        context.dispose();
      } finally {
        runtime.dispose();
      }
    }
  }
}

function installHostBridge(
  context: QuickJSContext,
  bridge: SandboxHostBridge,
  pending: Set<QuickJSDeferredPromise>,
  isActive: () => boolean,
  fail: (error: Error) => void,
  deliver: (outcome: GuestOutcome) => void,
  wake: () => void,
): void {
  const parseArgs = (json: string): unknown[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch (error) {
      throw new Error(
        `Workflow bridge received malformed argument JSON: ${toErrorMessage(error)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error('Workflow bridge arguments must decode to an array.');
    }
    return parsed;
  };

  const settleHostPromise = (
    deferred: QuickJSDeferredPromise,
    payload?: string,
    rejection?: unknown,
  ): void => {
    pending.delete(deferred);
    if (!isActive() || !deferred.alive) return;
    try {
      if (rejection !== undefined) {
        const errorHandle = context.newError(toErrorRecord(rejection));
        try {
          deferred.reject(errorHandle);
        } finally {
          errorHandle.dispose();
        }
      } else if (payload === undefined) {
        deferred.resolve();
      } else {
        const payloadHandle = context.newString(payload);
        try {
          deferred.resolve(payloadHandle);
        } finally {
          payloadHandle.dispose();
        }
      }
    } catch (error) {
      if (deferred.alive) deferred.dispose();
      fail(error instanceof Error ? error : new Error(toErrorMessage(error)));
    } finally {
      wake();
    }
  };

  defineHostGlobal(context, '__wfHostAsync', (nameHandle, argsHandle) => {
    const name = context.getString(nameHandle);
    const argsJson = context.getString(argsHandle);
    const fn = bridge.asyncFns[name];
    if (!fn) throw new Error(`Unknown workflow async primitive: ${name}`);

    const deferred = context.newPromise();
    pending.add(deferred);
    void fn(parseArgs(argsJson)).then(
      (payload) => {
        settleHostPromise(deferred, payload);
      },
      (error: unknown) => {
        settleHostPromise(deferred, undefined, error);
      },
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

async function pumpJobs(
  runtime: QuickJSRuntime,
  shouldStop: () => boolean,
  waitForWake: () => Promise<void>,
): Promise<void> {
  while (!shouldStop()) {
    const result = runtime.executePendingJobs(MAX_JOBS_PER_TURN);
    // Result delivery is the run's linearization point. A later guest job in
    // the same QuickJS batch must not replace that result with its own error.
    if (shouldStop()) {
      result.dispose();
      return;
    }
    const executed = result.unwrap();
    if (shouldStop()) return;

    if (executed === MAX_JOBS_PER_TURN || runtime.hasPendingJob()) {
      // Give host promises, sibling runtimes, and abort listeners a turn.
      await setImmediateAsync();
      continue;
    }

    await waitForWake();
  }
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(errorJson) as unknown;
    } catch (error) {
      return {
        error: new Error(
          `Workflow script returned malformed error JSON: ${toErrorMessage(error)}`,
        ),
      };
    }
    const decoded = GuestErrorRecordSchema.safeParse(parsed);
    if (!decoded.success) {
      return {
        error: new Error(
          'Workflow script returned an invalid error record from the sandbox.',
        ),
      };
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
    return { error };
  }
  if (payload === undefined) return { value: undefined };
  try {
    return { value: JSON.parse(payload) };
  } catch (error) {
    return {
      error: new Error(
        `Workflow script returned malformed result JSON: ${toErrorMessage(error)}`,
      ),
    };
  }
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
