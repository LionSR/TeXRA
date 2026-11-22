/**
 * The realm side of the bridge between a script and its host, which the
 * worker (`worker.ts`) evaluates before the script. It defines the
 * guest-facing globals, captures the host functions and deletes their
 * temporary globals, and evaluates to `{ start, settle }`, the two
 * functions the host calls, which stay host-side handles.
 * `tools.<name>(args)` returns a realm-native promise whose resolver waits
 * in a realm-side table keyed by op number; the host never holds a guest
 * object, and only JSON text crosses in either direction.
 */
'use strict';
(() => {
  const issue = globalThis.__csIssue;
  const log = globalThis.__csLog;
  const end = globalThis.__csDone;
  const config = JSON.parse(globalThis.__csConfig);
  let currentSection = null;
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
    Object.defineProperty(globalThis, name, {
      value,
      writable: false,
      configurable: false,
    });

  const pending = new Map();
  const call = (name, input, label) => {
    if (pending.size >= config.maxFanout) {
      return RealPromise.reject(
        new RealError(
          'A script may have at most ' +
            config.maxFanout +
            ' calls outstanding.',
        ),
      );
    }
    let json;
    try {
      json = stringify(input === undefined ? {} : input);
    } catch {
      json = undefined;
    }
    if (typeof json !== 'string') {
      return RealPromise.reject(
        new RealTypeError(label + '() takes a JSON-serializable argument.'),
      );
    }
    const seq = issue(name, json, currentSection);
    return new RealPromise((resolve, reject) =>
      pending.set(seq, { resolve, reject }),
    );
  };
  const tools = Object.create(null);
  for (const name of config.tools)
    tools[name] = (input) => call(name, input, 'tools.' + name);
  define('tools', freeze(tools));
  for (const name of config.globals)
    define(name, (...args) => call(name + '()', args, name));
  define('section', (title) => {
    currentSection = String(title);
  });
  const show = (value) => {
    if (typeof value === 'string') return value;
    try {
      const json = stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };
  define(
    'console',
    freeze({ log: (...values) => log(values.map(show).join(' ')) }),
  );

  const describe = (err) =>
    stringify({
      name:
        err && typeof err === 'object' && err.name ? String(err.name) : 'Error',
      message:
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : String(err),
      stack:
        err && typeof err === 'object' && err.stack
          ? String(err.stack)
          : undefined,
    });

  return freeze({
    start: (body) => {
      body().then(
        (value) => {
          let json;
          try {
            json = stringify(value);
          } catch {
            end(
              false,
              describe(
                new RealTypeError(
                  'The script returned a value that is not JSON-serializable.',
                ),
              ),
            );
            return;
          }
          end(true, json);
        },
        (err) => end(false, describe(err)),
      );
    },
    settle: (seq, ok, payload) => {
      const entry = pending.get(seq);
      if (entry === undefined)
        throw new RealError('No call ' + seq + ' is outstanding.');
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
})();
