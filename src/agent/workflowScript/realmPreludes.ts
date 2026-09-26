// Trusted realm-side source the sandbox evaluates before a workflow script
// body: plain JavaScript strings compiled inside QuickJS, never host code.
// sandbox.ts installs the determinism guards; runWorkflowScript.ts supplies
// the orchestration primitives as the realm prelude of its bridge.

/** Most items one parallel() or pipeline() call accepts. */
const MAX_FANOUT = 4096;

/**
 * Nondeterminism and dynamic-code guards. Journal replay requires stable call
 * order, while workflow scripts have no reason to compile source at runtime.
 */
export const DETERMINISM_PRELUDE = `
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
 * The fan-out primitives, defined INSIDE the sandbox realm (trusted prelude,
 * compiled by the host, run before the script body). They must not live
 * host-side: both consume script-created arrays and callbacks, and any host
 * code that calls a method on a
 * sandbox array (`thunks.map(hostCb)`) or awaits a sandbox thenable hands
 * the script a host-realm function whose .constructor is the host's
 * ungated Function constructor. Realm-side, every callback and resolve
 * function a script can capture is realm-local and codegen-gated.
 *
 * parallel() is a barrier. pipeline() carries each item through its stages
 * independently, so one item can be in a late stage while another is still in
 * an early one; a stage that yields null (a failed or skipped agent() call)
 * ends that item's chain as null. Thrown errors propagate from both, failing
 * the workflow, as they do everywhere in a script.
 *
 * agent() and log() are the bridged globals installed before this prelude
 * runs; concurrency, journaling, and the call cap all stay host-side in
 * agentPrimitive.
 */
export const ORCHESTRATION_PRELUDE = `
'use strict';
(() => {
  const MAX_FANOUT = ${MAX_FANOUT};
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, {
      value,
      writable: false,
      configurable: false,
    });
  define('parallel', async function parallel(thunks) {
    if (!Array.isArray(thunks)) {
      throw new Error(
        'parallel(thunks) requires an array of zero-arg functions.',
      );
    }
    if (thunks.length > MAX_FANOUT) {
      throw new Error('parallel() accepts at most ' + MAX_FANOUT + ' items.');
    }
    return Promise.all(
      thunks.map((thunk, i) => {
        if (typeof thunk !== 'function') {
          throw new Error('parallel(): item ' + i + ' is not a function.');
        }
        return thunk();
      }),
    );
  });
  define('pipeline', async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) {
      throw new Error('pipeline(items, ...stages) requires an array of items.');
    }
    if (items.length > MAX_FANOUT) {
      throw new Error('pipeline() accepts at most ' + MAX_FANOUT + ' items.');
    }
    if (stages.length === 0) {
      throw new Error('pipeline() requires at least one stage function.');
    }
    stages.forEach((stage, i) => {
      if (typeof stage !== 'function') {
        throw new Error('pipeline(): stage ' + i + ' is not a function.');
      }
    });
    return Promise.all(
      items.map(async (item, index) => {
        let value = item;
        for (const stage of stages) {
          value = await stage(value, item, index);
          if (value === null) return null;
        }
        return value;
      }),
    );
  });
})();
`;
