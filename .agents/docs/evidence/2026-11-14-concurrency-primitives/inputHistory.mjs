// The CLI input history's appends: a Semaphore(1) each submit's fork takes
// (the old shape) against one consumer of a bounded queue that drains when
// its scope closes (the new shape, `cli/src/chat/tui/history/inputHistory.ts`).
// Each submit is forked into the chat's scope, which a graceful exit closes
// first; the consumer lives in the platform's scope, which closes after.
// A store append takes 2 ms. Measured: entries stored, their order, and what
// a full queue does to a submit.
import { E } from './load.mjs';
const { Effect, Exit, Fiber, Queue, Scheduler, Scope, Semaphore, Stream } = E;

const SUBMITS = 20;
const append = (stored) => (value) =>
  Effect.sleep('2 millis').pipe(
    Effect.andThen(Effect.sync(() => stored.push(value))),
  );

const old = (budget) =>
  Effect.gen(function* () {
    const stored = [];
    const chat = yield* Scope.make();
    const lane = yield* Semaphore.make(1);
    for (let i = 0; i < SUBMITS; i++)
      yield* Effect.forkIn(lane.withPermit(append(stored)(i)), chat);
    yield* Effect.sleep('5 millis');
    yield* Scope.close(chat, Exit.void);
    return stored;
  }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget));

const now = (budget, capacity = 64) =>
  Effect.gen(function* () {
    const stored = [];
    const chat = yield* Scope.make();
    const platform = yield* Scope.make();
    const appends = yield* Queue.bounded(capacity);
    const consumer = yield* Stream.fromQueue(appends).pipe(
      Stream.runForEach(append(stored)),
      Effect.forkIn(platform),
    );
    yield* Scope.addFinalizer(
      platform,
      Queue.end(appends).pipe(Effect.andThen(Fiber.await(consumer))),
    );
    for (let i = 0; i < SUBMITS; i++)
      yield* Effect.forkIn(Queue.offer(appends, i), chat);
    yield* Effect.sleep('5 millis');
    yield* Scope.close(chat, Exit.void);
    yield* Scope.close(platform, Exit.void);
    return stored;
  }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget));

const inOrder = (stored) =>
  stored.every((v, i) => i === 0 || stored[i - 1] < v);

const report = async (name, run) => {
  let lost = 0;
  let disordered = 0;
  for (let budget = 2; budget <= 79; budget++) {
    const stored = await Effect.runPromise(run(budget));
    lost += SUBMITS - stored.length;
    if (!inOrder(stored)) disordered += 1;
  }
  console.log(
    `${name}: ${SUBMITS * 78} submits at budgets 2 to 79, ${lost} not stored, ${disordered} runs out of order`,
  );
};

await report('semaphore, forks in the chat scope', old);
await report('bounded(64) queue, one consumer drained at close', now);

// A full queue: capacity 4 against 20 submits made at once, the chat's scope
// closed 5 ms later. A submit past the bound waits for room in the chat's
// scope, so the ones still waiting when that scope closes are not stored.
{
  const stored = await Effect.runPromise(now(2048, 4));
  console.log(
    `bounded(4), 20 submits at once: ${stored.length} stored, in order: ${inOrder(stored)}`,
  );
}
