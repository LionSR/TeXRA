// The guest-side code of the code sandbox's realm, which the worker
// (`worker.ts`) evaluates before the script: the bridge the script calls the
// host through, and the guards that keep a replay exact.

/**
 * The guest-facing globals and the two functions the host calls. It captures
 * the host functions, deletes their temporary globals, and evaluates to
 * `{ start, settle }`, which stay host-side handles. `tools.<name>(args)`
 * returns a realm-native promise whose resolver waits in a realm-side table
 * keyed by op number; the host never holds a guest object, and only JSON text
 * crosses in either direction.
 */
export const BRIDGE_PRELUDE = `
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
export const DETERMINISM_PRELUDE = `
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
