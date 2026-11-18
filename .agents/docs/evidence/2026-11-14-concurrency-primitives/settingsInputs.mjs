// The settings view's inputs: which pages rebuild when a mutation says an
// input changed. Old shape: an unbounded PubSub of input names, each page
// filtering and keeping one pending rebuild (`Stream.buffer` sliding 1).
// New shape (`texra/src/controllers/settingsView/settingsViewBody.ts`): one
// count per input in one SubscriptionRef; a page rebuilds when a count it
// follows moved, one pending rebuild at most. Each page's build
// takes 3 ms. Measured, over random bursts of inputs at budgets 2 to 79:
// whether every page's last build started after the last change it follows
// (a lost change is a page left stale) and how many builds ran.
import { E } from './load.mjs';
const { Effect, Fiber, PubSub, Scheduler, Stream, SubscriptionRef } = E;

const INPUTS = ['view', 'settings', 'credentials', 'plugins', 'usage'];
const PAGES = [
  ['settings'],
  ['settings', 'credentials'],
  ['plugins'],
  ['usage'],
  [],
];
const follows = (page, input) => input === 'view' || page.includes(input);

const random = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const scenario = (budget, shape) =>
  Effect.gen(function* () {
    const next = random(budget * 7919);
    const plan = Array.from({ length: 40 }, () => ({
      input: INPUTS[Math.floor(next() * INPUTS.length)],
      gap: Math.floor(next() * 4),
    }));
    let clock = 0;
    const lastChange = PAGES.map(() => -1);
    const lastBuildStart = PAGES.map(() => -1);
    let builds = 0;
    const build = (i) =>
      Effect.sync(() => {
        lastBuildStart[i] = clock;
        builds += 1;
      }).pipe(Effect.andThen(Effect.sleep('3 millis')));
    let changed;
    let followers;
    if (shape === 'old') {
      const hub = yield* PubSub.unbounded();
      changed = (input) => PubSub.publish(hub, input);
      followers = PAGES.map((page, i) =>
        Stream.fromPubSub(hub).pipe(
          Stream.filter((input) => follows(page, input)),
          Stream.buffer({ capacity: 1, strategy: 'sliding' }),
          Stream.runForEach(() => build(i)),
        ),
      );
    } else {
      const counts = yield* SubscriptionRef.make(
        Object.fromEntries(INPUTS.map((k) => [k, 0])),
      );
      changed = (input) =>
        SubscriptionRef.update(counts, (c) => ({
          ...c,
          [input]: c[input] + 1,
        }));
      followers = PAGES.map((page, i) =>
        SubscriptionRef.changes(counts).pipe(
          Stream.map((c) => [c.view, ...page.map((k) => c[k])].join()),
          Stream.changes,
          Stream.drop(1),
          Stream.buffer({ capacity: 1, strategy: 'sliding' }),
          Stream.runForEach(() => build(i)),
        ),
      );
    }
    const fibers = yield* Effect.forEach(followers, (f) =>
      Effect.forkChild(f, { startImmediately: true }),
    );
    for (const { input, gap } of plan) {
      clock += 1;
      PAGES.forEach((page, i) => {
        if (follows(page, input)) lastChange[i] = clock;
      });
      yield* changed(input);
      if (gap > 0) yield* Effect.sleep(`${gap} millis`);
    }
    yield* Effect.sleep('20 millis');
    yield* Effect.forEach(fibers, Fiber.interrupt);
    const stale = PAGES.filter(
      (_, i) => lastChange[i] > lastBuildStart[i],
    ).length;
    return { stale, builds };
  }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget));

for (const shape of ['old', 'new']) {
  let stale = 0;
  let builds = 0;
  for (let budget = 2; budget <= 79; budget++) {
    const r = await Effect.runPromise(scenario(budget, shape));
    stale += r.stale;
    builds += r.builds;
  }
  console.log(
    `${shape}: ${78 * PAGES.length} page runs, ${stale} left stale, ${builds} builds`,
  );
}

// A follower that subscribes between two changes: the current counts are its
// baseline, so the change after it subscribed rebuilds it once and the one
// before does not.
{
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const counts = yield* SubscriptionRef.make({ view: 0 });
      const bump = SubscriptionRef.update(counts, (c) => ({
        view: c.view + 1,
      }));
      yield* bump;
      let rebuilt = 0;
      const fiber = yield* SubscriptionRef.changes(counts).pipe(
        Stream.map((c) => c.view),
        Stream.changes,
        Stream.drop(1),
        Stream.runForEach(() => Effect.sync(() => (rebuilt += 1))),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* bump;
      yield* Effect.sleep('5 millis');
      yield* Fiber.interrupt(fiber);
      return rebuilt;
    }),
  );
  console.log(`subscribe between two changes: ${result} rebuild (expected 1)`);
}

// Why not a PubSub.sliding(1) of the counts: `publishUnsafe` skips the
// strategy and refuses a full subscriber, so the newest value is the one
// lost; 1 to 10 published at once to a 3 ms reader.
{
  const got = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* PubSub.sliding(1);
      const got = [];
      const fiber = yield* Stream.fromPubSub(hub).pipe(
        Stream.runForEach((v) =>
          Effect.sync(() => got.push(v)).pipe(
            Effect.andThen(Effect.sleep('3 millis')),
          ),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.sleep('1 millis');
      for (let i = 1; i <= 10; i++) PubSub.publishUnsafe(hub, i);
      yield* Effect.sleep('20 millis');
      yield* Fiber.interrupt(fiber);
      return got;
    }),
  );
  console.log(`PubSub.sliding(1) with publishUnsafe, read: ${got.join(',')}`);
}
