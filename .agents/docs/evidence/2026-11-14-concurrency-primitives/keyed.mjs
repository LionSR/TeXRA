import { E } from './load.mjs';
const {
  Effect,
  Fiber,
  RcMap,
  RcRef,
  ScopedCache,
  Cache,
  Resource,
  Scope,
  Exit,
  Duration,
  Deferred,
  Schedule,
} = E;
const run = (eff) => Effect.runPromise(Effect.scoped(eff));
const log = [];
const mkLookup = (opts = {}) => {
  let n = 0;
  return (key) =>
    Effect.gen(function* () {
      const id = `${key}#${++n}`;
      log.push(`open ${id}`);
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          Effect.sleep(opts.closeMs ?? 0),
          Effect.sync(() => {
            log.push(`closed ${id}`);
          }),
        ),
      );
      if (opts.openMs) yield* Effect.sleep(opts.openMs);
      if (opts.failFirst && n === 1) return yield* Effect.fail('boom');
      return id;
    });
};
const out = {};
// RcMap 1: one-shot reader with idleTimeToLive 0 vs >0
out.rcmapIdle = await run(
  Effect.gen(function* () {
    log.length = 0;
    const zero = yield* RcMap.make({ lookup: mkLookup() });
    yield* Effect.scoped(RcMap.get(zero, 'z'));
    yield* Effect.scoped(RcMap.get(zero, 'z'));
    const idle = yield* RcMap.make({
      lookup: mkLookup(),
      idleTimeToLive: '50 millis',
    });
    const a = yield* Effect.scoped(RcMap.get(idle, 'i'));
    const b = yield* Effect.scoped(RcMap.get(idle, 'i'));
    yield* Effect.sleep(80);
    const c = yield* Effect.scoped(RcMap.get(idle, 'i'));
    const inf = yield* RcMap.make({
      lookup: mkLookup(),
      idleTimeToLive: Duration.infinity,
    });
    yield* Effect.scoped(RcMap.get(inf, 'f'));
    yield* Effect.sleep(20);
    const f2 = yield* Effect.scoped(RcMap.get(inf, 'f'));
    return { log: [...log], idleReads: [a, b, c], infiniteSecondRead: f2 };
  }),
);
// RcMap 2: failed lookup is kept while held / within idle TTL
out.rcmapFailure = await run(
  Effect.gen(function* () {
    log.length = 0;
    const zero = yield* RcMap.make({ lookup: mkLookup({ failFirst: true }) });
    const r1 = yield* Effect.exit(Effect.scoped(RcMap.get(zero, 'k')));
    const r2 = yield* Effect.exit(Effect.scoped(RcMap.get(zero, 'k')));
    const idle = yield* RcMap.make({
      lookup: mkLookup({ failFirst: true }),
      idleTimeToLive: '1 second',
    });
    const s1 = yield* Effect.exit(Effect.scoped(RcMap.get(idle, 'k')));
    const s2 = yield* Effect.exit(Effect.scoped(RcMap.get(idle, 'k')));
    return {
      ttl0: [Exit.isFailure(r1), Exit.isFailure(r2)],
      ttl1s: [Exit.isFailure(s1), Exit.isFailure(s2)],
      log: [...log],
    };
  }),
);
// RcMap 3: interrupting the only caller of a slow lookup; invalidate while held; get during close
out.rcmapInvalidate = await run(
  Effect.gen(function* () {
    log.length = 0;
    const m = yield* RcMap.make({
      lookup: mkLookup({ openMs: 30, closeMs: 30 }),
      idleTimeToLive: Duration.infinity,
    });
    const f = yield* Effect.forkChild(Effect.scoped(RcMap.get(m, 'k')));
    yield* Effect.sleep(5);
    yield* Fiber.interrupt(f);
    const hasAfterCallerInterrupt = yield* RcMap.has(m, 'k');
    yield* Effect.sleep(40);
    log.push('--held, then invalidate');
    const holder = yield* Scope.make();
    const v1 = yield* RcMap.get(m, 'k').pipe(Scope.provide(holder));
    yield* RcMap.invalidate(m, 'k');
    const v2 = yield* Effect.scoped(RcMap.get(m, 'k')); // second instance while the first is still held
    log.push(`held ${v1}, new ${v2}`);
    yield* Scope.close(holder, Exit.void);
    log.push('--invalidate idle, get during its close');
    const closing = yield* Effect.forkChild(RcMap.invalidate(m, 'k'));
    yield* Effect.sleep(5);
    const v3 = yield* Effect.scoped(RcMap.get(m, 'k'));
    log.push(`got ${v3}`);
    yield* Fiber.join(closing);
    return { hasAfterCallerInterrupt, log: [...log] };
  }),
);
// ScopedCache: no reader scope, explicit close with invalidate, get during close
out.scopedCache = await run(
  Effect.gen(function* () {
    log.length = 0;
    const c = yield* ScopedCache.make({
      lookup: mkLookup({ openMs: 10, closeMs: 30 }),
      capacity: 100,
    });
    const a = yield* ScopedCache.get(c, 'k');
    const b = yield* ScopedCache.get(c, 'k');
    log.push(`reads ${a} ${b}`);
    const closing = yield* Effect.forkChild(ScopedCache.invalidate(c, 'k'));
    yield* Effect.sleep(5);
    const d = yield* ScopedCache.get(c, 'k');
    log.push(`got ${d}`);
    yield* Fiber.join(closing);
    return [...log];
  }),
);
// single flight
out.singleFlight = await run(
  Effect.gen(function* () {
    let runs = 0;
    const refresh = Effect.gen(function* () {
      const n = ++runs;
      yield* Effect.sleep(20);
      if (n === 1) return yield* Effect.fail('expired');
      return `token${n}`;
    });
    const [get, invalidate] = yield* Effect.cachedInvalidateWithTTL(
      refresh,
      (exit) => (Exit.isSuccess(exit) ? '50 millis' : Duration.zero),
    );
    const first = yield* Effect.all(
      Array.from({ length: 5 }, () => Effect.exit(get)),
      { concurrency: 'unbounded' },
    );
    const afterFirst = runs;
    const second = yield* Effect.all(
      Array.from({ length: 5 }, () => get),
      { concurrency: 'unbounded' },
    );
    const afterSecond = runs;
    yield* get;
    const cachedHit = runs;
    yield* Effect.sleep(60);
    yield* get;
    const afterTtl = runs;
    yield* invalidate;
    yield* get;
    const afterInvalidate = runs;
    // all callers interrupted -> run abandoned, next caller starts fresh
    const f = yield* Effect.forkChild(Effect.andThen(invalidate, get));
    yield* Effect.sleep(5);
    yield* Fiber.interrupt(f);
    const before = runs;
    yield* get;
    // Effect.cached keeps a failure for good
    let c = 0;
    const cached = yield* Effect.cached(
      Effect.suspend(() => (++c === 1 ? Effect.fail('x') : Effect.succeed(c))),
    );
    const e1 = yield* Effect.exit(cached),
      e2 = yield* Effect.exit(cached);
    // Cache: keyed single flight with per-exit TTL
    let k = 0;
    const cache = yield* Cache.makeWith(
      (key) =>
        Effect.andThen(
          Effect.sleep(10),
          Effect.sync(() => `${key}:${++k}`),
        ),
      {
        capacity: 10,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? '1 hour' : Duration.zero),
      },
    );
    const vals = yield* Effect.all(
      Array.from({ length: 4 }, () => Cache.get(cache, 'cat')),
      { concurrency: 'unbounded' },
    );
    const stale = yield* Cache.invalidateWhen(
      cache,
      'cat',
      (v) => v === 'not-mine',
    );
    const mine = yield* Cache.invalidateWhen(
      cache,
      'cat',
      (v) => v === 'cat:1',
    );
    // Resource.refresh: concurrent refreshes each acquire
    let acq = 0;
    const res = yield* Resource.manual(
      Effect.andThen(
        Effect.sleep(10),
        Effect.sync(() => ++acq),
      ),
    );
    yield* Effect.all(
      Array.from({ length: 4 }, () => Resource.refresh(res)),
      { concurrency: 'unbounded' },
    );
    return {
      fiveCallersFailingRun: {
        runs: afterFirst,
        failures: first.filter(Exit.isFailure).length,
      },
      fiveCallersNext: { runs: afterSecond, values: [...new Set(second)] },
      cachedHit,
      afterTtl,
      afterInvalidate,
      abandonedThenFresh: [before, runs],
      effectCachedFailureKept: [Exit.isFailure(e1), Exit.isFailure(e2), c],
      cacheSingleFlight: vals,
      invalidateWhen: [stale, mine],
      resourceAcquiresAfter4ConcurrentRefresh: acq,
    };
  }),
);
console.log(JSON.stringify(out, null, 1));
