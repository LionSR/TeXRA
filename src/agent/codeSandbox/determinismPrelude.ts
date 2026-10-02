// Trusted realm-side source the code sandbox worker and the workflow sandbox
// evaluate before a script body: plain JavaScript compiled inside QuickJS,
// never host code.

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
