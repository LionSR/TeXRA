import * as vm from 'node:vm';

import { toErrorMessage } from '@utils/errors/errorMessage';

import { WorkflowScriptParseError } from './parseScript';

export interface SandboxHostBridge {
  /**
   * Async primitives (agent). Arguments arrive as plain host data — the
   * realm-local wrapper JSON-stringifies them with the sandbox's pristine
   * (prelude-captured) JSON.stringify before crossing, and this module
   * parses them host-side, so host code never touches sandbox objects.
   * The host returns the result JSON-stringified; the realm-local wrapper
   * revives it with the sandbox's own JSON so scripts only ever hold
   * realm-local values.
   */
  asyncFns: Record<string, (args: unknown[]) => Promise<string | undefined>>;
  /**
   * Sync primitives (log, phase). Same data-only argument marshaling as
   * asyncFns. Must return only primitives (string/undefined) — primitives
   * cross realms without leaking objects.
   */
  syncFns: Record<string, (args: unknown[]) => string | undefined>;
  /** JSON payload for the `args` global; undefined installs `args` as undefined. */
  argsJson: string | undefined;
  /**
   * Trusted realm-side preludes run after the bridge is installed and
   * before the script body. Fan-out primitives (parallel, pipeline,
   * concat) live here so thunks, arrays, and promises produced by the
   * script never cross into host code — awaiting a sandbox thenable or
   * passing a host callback into a sandbox-dispatched array method would
   * hand the script a host-realm function whose .constructor is the
   * host's ungated Function constructor.
   */
  realmPreludes?: string[];
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
  // Instances must not hand back the unguarded constructor. Locked like
  // every other guard here so a script cannot reassign it back to RealDate
  // (defense in depth: globalThis.Date is already non-writable and code
  // generation is disabled).
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
 * never touch host-realm callables or objects, and host code never touches
 * sandbox objects: the wrappers are created by this (sandbox-compiled)
 * code, so their .constructor is the sandbox's codeGeneration-gated
 * Function; arguments leave the realm as JSON text (pristine stringify,
 * captured before script code runs); async results arrive as JSON text and
 * are revived with the sandbox's own JSON.parse; host errors are re-thrown
 * as realm-local Errors carrying only name/message strings; the script's
 * own settlement is reported through the installResult channel as JSON
 * text rather than awaited host-side. This closes the classic node:vm
 * escape (hostFn.constructor === host Function) in both directions — a
 * host callback handed to a sandbox-dispatched method, or a host resolve
 * function handed to a sandbox thenable, would reopen it — which static
 * import bans cannot catch.
 */
const BRIDGE_PRELUDE = `
'use strict';
(() => {
  const parseJson = JSON.parse;
  // Pristine stringify captured before any script code runs: argument
  // marshaling must not be subvertible by a script reassigning
  // JSON.stringify, and stringifying realm-side means host code only ever
  // parses text — it never walks a sandbox object graph.
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
  const marshalArgs = (args) => stringifyJson(args) ?? '[]';
  return {
    installAsync(name, hostInvoke) {
      define(name, function (...args) {
        const pending = (async () => {
          let payload;
          try {
            payload = await hostInvoke(marshalArgs(args));
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
          return hostInvoke(marshalArgs(args));
        } catch (err) {
          throw toRealmError(err);
        }
      });
    },
    installValue(name, json) {
      define(name, json === undefined ? undefined : parseJson(json));
    },
    installResult(hostDeliver) {
      // Result channel: the trusted body wrapper (compiled by the host,
      // running realm-side) reports the script's settlement here as JSON
      // text. Only strings reach hostDeliver, so the host never awaits or
      // .then()s a sandbox promise — a script that overrides its realm's
      // Promise.prototype.then can only capture realm-local callbacks.
      // First delivery wins; a script calling this early merely forges
      // its own result (no capability crosses either way).
      let delivered = false;
      define('__wfDeliverResult', function (value, isError) {
        if (delivered) return;
        delivered = true;
        if (isError) {
          const err = toRealmError(value);
          hostDeliver(
            undefined,
            stringifyJson({ name: err.name, message: err.message }),
          );
          return;
        }
        hostDeliver(
          value === undefined ? undefined : (stringifyJson(value) ?? 'null'),
          undefined,
        );
      });
    },
  };
})();
`;

interface RealmBridgeInstaller {
  installAsync(name: string, hostInvoke: unknown): void;
  installSync(name: string, hostInvoke: unknown): void;
  installValue(name: string, json: string | undefined): void;
  installResult(hostDeliver: unknown): void;
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
  // Arguments arrive as JSON text (marshaled realm-side with the pristine
  // stringify); parse them here so bridge fns receive plain host data and
  // no host code path ever dispatches through a sandbox object.
  const parseArgs = (argsJson: unknown): unknown[] => {
    if (typeof argsJson !== 'string') return [];
    try {
      const parsed = JSON.parse(argsJson) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  for (const [name, fn] of Object.entries(bridge.asyncFns)) {
    installer.installAsync(name, (argsJson: unknown) =>
      fn(parseArgs(argsJson)),
    );
  }
  for (const [name, fn] of Object.entries(bridge.syncFns)) {
    installer.installSync(name, (argsJson: unknown) => fn(parseArgs(argsJson)));
  }
  installer.installValue('args', bridge.argsJson);

  // The script's settlement arrives through the realm-side result channel
  // as JSON text — never by awaiting the sandbox promise host-side, which
  // would pass host-realm resolve callbacks into a (script-overridable)
  // sandbox `then`.
  let deliverResolve!: (value: unknown) => void;
  let deliverReject!: (error: Error) => void;
  const delivered = new Promise<unknown>((resolve, reject) => {
    deliverResolve = resolve;
    deliverReject = reject;
  });
  installer.installResult((payload?: string, errorJson?: string) => {
    if (typeof errorJson === 'string') {
      let name = 'Error';
      let message = errorJson;
      try {
        const parsed = JSON.parse(errorJson) as {
          name?: unknown;
          message?: unknown;
        };
        name = typeof parsed.name === 'string' ? parsed.name : 'Error';
        message = typeof parsed.message === 'string' ? parsed.message : '';
      } catch {
        // Fall back to the raw text as the message.
      }
      const error = new Error(message);
      error.name = name;
      deliverReject(error);
      return;
    }
    if (typeof payload !== 'string') {
      deliverResolve(undefined);
      return;
    }
    try {
      deliverResolve(JSON.parse(payload));
    } catch (error) {
      deliverReject(
        new Error(
          `Workflow script returned malformed result JSON: ${toErrorMessage(error)}`,
        ),
      );
    }
  });

  for (const prelude of bridge.realmPreludes ?? []) {
    new vm.Script(prelude, {
      filename: 'workflow-orchestration.js',
    }).runInContext(context, { timeout: 1_000 });
  }

  let script: vm.Script;
  try {
    // Strict mode is load-bearing, not style: it poisons
    // arguments.callee/.caller for every function the script defines
    // (defense in depth on top of the data-only bridge). The trailing
    // .then is trusted host-authored code running realm-side, so even if
    // the script's synchronous prologue replaced Promise.prototype.then,
    // the callbacks it captures are realm-local functions.
    script = new vm.Script(
      `(async () => {\n'use strict';\n${body}\n})().then(\n` +
        `  (value) => { __wfDeliverResult(value, false); },\n` +
        `  (error) => { __wfDeliverResult(error, true); },\n` +
        `);`,
      { filename: options.filename },
    );
  } catch (error) {
    throw new WorkflowScriptParseError(
      `Workflow script syntax error: ${toErrorMessage(error)}`,
    );
  }

  // The vm-level timeout only bounds the synchronous portion; the overall
  // async run is bounded by the race below.
  script.runInContext(context, {
    timeout: Math.min(options.timeoutMs, 5_000),
  });
  return await withTimeout(delivered, options);
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
          try {
            options.onTimeout?.();
          } catch {
            // The timeout rejection below must fire even if the abort
            // callback throws; otherwise the race never settles.
          }
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
