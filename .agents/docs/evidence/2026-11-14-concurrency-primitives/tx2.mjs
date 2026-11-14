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
  SubscriptionRef,
  Semaphore,
} = E;
const run = (eff, budget) =>
  Effect.runPromise(
    budget
      ? Effect.provideService(eff, Scheduler.MaxOpsBeforeYield, budget)
      : eff,
  );
const noops = (n) =>
  n === 0
    ? Effect.void
    : Effect.forEach(Array.from({ length: n }), () => Effect.void, {
        discard: true,
      });

// (e) multi-ref invariant + check-then-act under budgets 2..79
let invariantBreaks = 0,
  lateRegs = 0,
  txs = 0;
for (let budget = 2; budget <= 79; budget++) {
  await run(
    Effect.gen(function* () {
      const a = yield* TxRef.make(1000),
        b = yield* TxRef.make(0);
      const closed = yield* TxRef.make(false);
      const reg = yield* TxHashMap.empty();
      const closedSeen = { at: -1 };
      let seq = 0;
      const regAt = [];
      const transfer = Effect.tx(
        Effect.gen(function* () {
          const x = yield* TxRef.get(a);
          yield* noops(3);
          yield* TxRef.set(a, x - 1);
          yield* noops(2);
          yield* TxRef.update(b, (y) => y + 1);
        }),
      );
      const check = Effect.tx(
        Effect.gen(function* () {
          const x = yield* TxRef.get(a);
          yield* noops(4);
          const y = yield* TxRef.get(b);
          return x + y;
        }),
      ).pipe(
        Effect.tap((s) =>
          Effect.sync(() => {
            txs++;
            if (s !== 1000) invariantBreaks++;
          }),
        ),
      );
      const register = (i) =>
        Effect.tx(
          Effect.gen(function* () {
            if (yield* TxRef.get(closed)) return false;
            yield* noops(i % 7);
            yield* TxHashMap.set(reg, i, true);
            return true;
          }),
        ).pipe(
          Effect.tap((ok) =>
            Effect.sync(() => {
              if (ok) regAt.push(seq++);
            }),
          ),
        );
      const close = Effect.tx(
        Effect.gen(function* () {
          yield* TxRef.set(closed, true);
          return yield* TxHashMap.size(reg);
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            closedSeen.at = seq++;
          }),
        ),
      );
      const fibers = [];
      for (let i = 0; i < 40; i++) {
        fibers.push(
          yield* Effect.forkChild(Effect.andThen(noops(i % 11), transfer)),
        );
        fibers.push(
          yield* Effect.forkChild(Effect.andThen(noops(i % 5), check)),
        );
        fibers.push(
          yield* Effect.forkChild(Effect.andThen(noops(i % 13), register(i))),
        );
        if (i === 20)
          fibers.push(yield* Effect.forkChild(Effect.andThen(noops(9), close)));
      }
      yield* Fiber.joinAll(fibers);
      const sizeAtEnd = yield* TxHashMap.size(reg);
      // registrations after close?
      lateRegs += regAt.filter((s) => s > closedSeen.at).length;
      const sum = (yield* TxRef.get(a)) + (yield* TxRef.get(b));
      if (sum !== 1000 || (yield* TxRef.get(b)) !== 40) invariantBreaks++;
    }),
    budget,
  );
}
console.log(
  'budgets 2..79: invariant breaks',
  invariantBreaks,
  'of',
  txs,
  'reads; registrations committed after close',
  lateRegs,
);

// (f) cost per op
const time = async (label, mk, n = 200000) => {
  const eff = await Effect.runPromise(mk);
  const t0 = process.hrtime.bigint();
  await Effect.runPromise(
    Effect.forEach(Array.from({ length: n }), () => eff, { discard: true }),
  );
  const ns = Number(process.hrtime.bigint() - t0) / n;
  console.log(label.padEnd(46), ns.toFixed(0), 'ns/op');
};
for (let r = 0; r < 2; r++) {
  await time(
    'Effect.sync(() => x++)',
    Effect.sync(() => {
      let x = 0;
      return Effect.sync(() => {
        x++;
      });
    }),
  );
  await time(
    'Ref.update',
    Effect.map(Ref.make(0), (r) => Ref.update(r, (n) => n + 1)),
  );
  await time(
    'SynchronizedRef.update',
    Effect.map(SynchronizedRef.make(0), (r) =>
      SynchronizedRef.update(r, (n) => n + 1),
    ),
  );
  await time(
    'SubscriptionRef.update',
    Effect.map(SubscriptionRef.make(0), (r) =>
      SubscriptionRef.update(r, (n) => n + 1),
    ),
  );
  await time(
    'Semaphore(1).withPermit(sync)',
    Effect.map(Semaphore.make(1), (s) => s.withPermit(Effect.void)),
  );
  await time(
    'TxRef.update (own tx)',
    Effect.map(TxRef.make(0), (r) => TxRef.update(r, (n) => n + 1)),
  );
  await time(
    'tx { get; set } 1 ref',
    Effect.map(TxRef.make(0), (r) =>
      Effect.tx(Effect.flatMap(TxRef.get(r), (v) => TxRef.set(r, v + 1))),
    ),
  );
  await time(
    'tx { 2 refs get+set }',
    Effect.map(Effect.all([TxRef.make(0), TxRef.make(0)]), ([a, b]) =>
      Effect.tx(
        Effect.gen(function* () {
          const x = yield* TxRef.get(a);
          yield* TxRef.set(a, x + 1);
          yield* TxRef.update(b, (y) => y + 1);
        }),
      ),
    ),
  );
  await time(
    'TxHashMap.set',
    Effect.map(TxHashMap.empty(), (m) => TxHashMap.set(m, 'k', 1)),
  );
  await time(
    'TxSemaphore.withPermit(void)',
    Effect.map(TxSemaphore.make(1), (s) =>
      TxSemaphore.withPermit(s, Effect.void),
    ),
  );
}
