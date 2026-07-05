import * as vm from 'node:vm';

import { toErrorMessage } from '@common/errors';

import { WorkflowScriptParseError } from './parseScript';

export interface SandboxHostBridge {
  /**
   * Async primitives (agent, parallel, pipeline). The host returns the
   * result JSON-stringified; the realm-local wrapper revives it with the
   * sandbox's own JSON so scripts only ever hold realm-local values.
   */
  asyncFns: Record<string, (args: unknown[]) => Promise<string | undefined>>;
  /**
   * Sync primitives (concat, log, phase). Must return only primitives
   * (string/undefined) — primitives cross realms without leaking objects.
   */
  syncFns: Record<string, (args: unknown[]) => string | undefined>;
  /** JSON payload for the `args` global; undefined installs `args` as undefined. */
  argsJson: string | undefined;
}

export interface SandboxOptions {
  /** Wall-clock cap for the whole (async) script run. */
  timeoutMs: number;
  filename: string;
  /**
   * Fired when the wall-clock timeout wins the race, before rejecting.
   * The caller uses this to abort in-flight and future agent work — the
   * orphaned script continuation itself cannot be killed, but with the
   * primitives refusing new work it can only run pure JS to completion.
   */
  onTimeout?: () => void;
}

/**
 * Nondeterminism guards: journal replay assumes a script issues the same
 * agent() calls in the same order every run, so wall-clock and randomness
 * are unavailable (pass timestamps via args, vary prompts by index).
 * Guards are installed non-writable/non-configurable so scripts cannot
 * reassign them, and argless `new Date()` / `Date.now()` both throw while
 * explicit-timestamp construction (`new Date(0)`) stays usable.
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
  // Instances must not hand back the unguarded constructor.
  Object.defineProperty(RealDate.prototype, 'constructor', {
    value: GuardedDate,
  });
  Object.defineProperty(globalThis, 'Date', {
    value: GuardedDate,
    writable: false,
    configurable: false,
  });

  // Intl.DateTimeFormat().format() with no argument reads the wall clock.
  // Deterministic orchestration scripts have no use for locale APIs, so
  // remove Intl wholesale rather than chase its implicit-"now" paths.
  Object.defineProperty(globalThis, 'Intl', {
    value: undefined,
    writable: false,
    configurable: false,
  });
})();
`;

/**
 * Installs host primitives behind realm-local wrapper functions. Scripts
 * never touch host-realm callables or objects: the wrappers are created by
 * this (sandbox-compiled) code, so their .constructor is the sandbox's
 * codeGeneration-gated Function; async results arrive as JSON text and are
 * revived with the sandbox's own JSON.parse; host errors are re-thrown as
 * realm-local Errors carrying only name/message strings. This closes the
 * classic node:vm escape (hostFn.constructor === host Function), which
 * static import bans cannot catch.
 */
const BRIDGE_PRELUDE = `
'use strict';
(() => {
  const parseJson = JSON.parse;
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
  return {
    installAsync(name, hostInvoke) {
      define(name, function (...args) {
        const pending = (async () => {
          let payload;
          try {
            payload = await hostInvoke(args);
          } catch (err) {
            throw toRealmError(err);
          }
          return payload === undefined ? undefined : parseJson(payload);
        })();
        // A call the script abandons without awaiting must not surface as
        // an unhandled rejection; awaited callers still see the error.
        pending.catch(() => {});
        return pending;
      });
    },
    installSync(name, hostInvoke) {
      define(name, function (...args) {
        try {
          return hostInvoke(args);
        } catch (err) {
          throw toRealmError(err);
        }
      });
    },
    installValue(name, json) {
      define(name, json === undefined ? undefined : parseJson(json));
    },
  };
})();
`;

interface RealmBridgeInstaller {
  installAsync(name: string, hostInvoke: unknown): void;
  installSync(name: string, hostInvoke: unknown): void;
  installValue(name: string, json: string | undefined): void;
}

// vm.Script is context-independent; compile the preludes once per process.
const PRELUDE_SCRIPT = new vm.Script(DETERMINISM_PRELUDE, {
  filename: 'workflow-prelude.js',
});
const BRIDGE_SCRIPT = new vm.Script(BRIDGE_PRELUDE, {
  filename: 'workflow-bridge.js',
});

/**
 * Evaluates a workflow script body in a fresh `node:vm` realm. Dynamic code
 * generation is disabled, the realm has no `require`/`process`, and every
 * host capability crosses through the realm-local bridge above, so the
 * script cannot reach host-realm function constructors or objects.
 *
 * PROTOTYPE NOTE: `node:vm` is still not a certified security boundary the
 * way a separate isolate is, and it cannot preempt CPU-bound continuations:
 * the vm-level timeout covers only the initial synchronous portion, so
 * `await agent(...); while (true) {}` blocks the event loop and defeats the
 * wall-clock timer. A preemptible isolate (quickjs-emscripten) behind this
 * same `runScriptInSandbox` signature is a HARD GATE before the engine is
 * wired to a delegate_workflow_script tool and real execution.
 */
export async function runScriptInSandbox(
  body: string,
  bridge: SandboxHostBridge,
  options: SandboxOptions,
): Promise<unknown> {
  const context = vm.createContext(
    {},
    { codeGeneration: { strings: false, wasm: false } },
  );
  PRELUDE_SCRIPT.runInContext(context);
  const installer = BRIDGE_SCRIPT.runInContext(context) as RealmBridgeInstaller;
  for (const [name, fn] of Object.entries(bridge.asyncFns)) {
    installer.installAsync(name, fn);
  }
  for (const [name, fn] of Object.entries(bridge.syncFns)) {
    installer.installSync(name, fn);
  }
  installer.installValue('args', bridge.argsJson);

  let script: vm.Script;
  try {
    // Strict mode is load-bearing, not style: it poisons
    // arguments.callee/.caller for every function the script defines, so a
    // sandbox-authored thunk invoked from host code (parallel/pipeline)
    // cannot walk .caller up to a host function and reach the host's
    // Function constructor.
    script = new vm.Script(`(async () => {\n'use strict';\n${body}\n})()`, {
      filename: options.filename,
    });
  } catch (error) {
    throw new WorkflowScriptParseError(
      `Workflow script syntax error: ${toErrorMessage(error)}`,
    );
  }

  // The vm-level timeout only bounds the synchronous portion; the overall
  // async run is bounded by the race below.
  const evaluated = script.runInContext(context, {
    timeout: Math.min(options.timeoutMs, 5_000),
  }) as Promise<unknown>;
  return await withTimeout(evaluated, options);
}

async function withTimeout(
  promise: Promise<unknown>,
  options: SandboxOptions,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          options.onTimeout?.();
          // The script continuation is orphaned past this point; suppress
          // its eventual settlement so it cannot surface as an unhandled
          // rejection after the run already reported the timeout.
          promise.catch(() => {});
          reject(
            new Error(
              `Workflow script ${options.filename} timed out after ${options.timeoutMs}ms`,
            ),
          );
        }, options.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
