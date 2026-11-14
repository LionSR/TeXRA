import { E } from './load.mjs';
const {
  Effect,
  TxRef,
  TxSemaphore,
  TxHashMap,
  Fiber,
  Scheduler,
  Ref,
  SynchronizedRef,
  Deferred,
  Exit,
  Cause,
} = E;
const run = (eff, budget) =>
  Effect.runPromise(
    budget
      ? Effect.provideService(eff, Scheduler.MaxOpsBeforeYield, budget)
      : eff,
  );
const out = {};

// (a) body may await; conflicting commit re-runs the body
out.a = await run(
  Effect.gen(function* () {
    const ref = yield* TxRef.make(0);
    let bodyRuns = 0;
    const f = yield* Effect.forkChild(
      Effect.tx(
        Effect.gen(function* () {
          bodyRuns++;
          const v = yield* TxRef.get(ref);
          yield* Effect.sleep(20); // awaits inside the transaction
          yield* TxRef.set(ref, v + 100);
          return v;
        }),
      ),
    );
    yield* Effect.sleep(5);
    yield* TxRef.set(ref, 1); // another transaction commits during the wait
    const read = yield* Fiber.join(f);
    return { bodyRuns, readOnCommit: read, final: yield* TxRef.get(ref) };
  }),
);

// (b) txRetry: what wakes; pending registration; interruption cleans
out.b = await run(
  Effect.gen(function* () {
    const flag = yield* TxRef.make(false);
    const other = yield* TxRef.make(0);
    let attempts = 0;
    const waiter = yield* Effect.forkChild(
      Effect.tx(
        Effect.gen(function* () {
          attempts++;
          if (!(yield* TxRef.get(flag))) return yield* Effect.txRetry;
          return 'woke';
        }),
      ),
    );
    yield* Effect.sleep(5);
    const pendingWhileWaiting = flag.pending.size;
    yield* TxRef.set(other, 1); // unrelated ref: no wake
    yield* Effect.sleep(5);
    const afterUnrelated = attempts;
    yield* TxRef.set(flag, false); // same value write: wakes (re-check), version unchanged
    yield* Effect.sleep(5);
    const afterSameValue = attempts;
    // interrupt a second waiter
    const w2 = yield* Effect.forkChild(
      Effect.tx(
        Effect.gen(function* () {
          if (!(yield* TxRef.get(flag))) return yield* Effect.txRetry;
          return 'woke2';
        }),
      ),
    );
    yield* Effect.sleep(5);
    const pending2 = flag.pending.size;
    yield* Fiber.interrupt(w2);
    const pendingAfterInterrupt = flag.pending.size;
    yield* TxRef.set(flag, true);
    const r = yield* Fiber.join(waiter);
    return {
      pendingWhileWaiting,
      afterUnrelated,
      afterSameValue,
      pending2,
      pendingAfterInterrupt,
      r,
      attempts,
      pendingEnd: flag.pending.size,
    };
  }),
);

// (c) interruption mid-body: nothing committed
out.c = await run(
  Effect.gen(function* () {
    const a = yield* TxRef.make(0);
    const b = yield* TxRef.make(0);
    const f = yield* Effect.forkChild(
      Effect.tx(
        Effect.gen(function* () {
          yield* TxRef.set(a, 1);
          yield* Effect.sleep(50);
          yield* TxRef.set(b, 1);
        }),
      ),
    );
    yield* Effect.sleep(5);
    const exit = yield* Fiber.interrupt(f).pipe(Effect.andThen(Fiber.await(f)));
    return {
      a: yield* TxRef.get(a),
      b: yield* TxRef.get(b),
      interrupted: Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause),
    };
  }),
);

// (d) failure in body rolls back
out.d = await run(
  Effect.gen(function* () {
    const a = yield* TxRef.make(0);
    const ex = yield* Effect.exit(
      Effect.tx(
        Effect.gen(function* () {
          yield* TxRef.set(a, 1);
          return yield* Effect.fail('boom');
        }),
      ),
    );
    return { a: yield* TxRef.get(a), failed: Exit.isFailure(ex) };
  }),
);
console.log(JSON.stringify(out, null, 1));
