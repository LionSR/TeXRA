import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(
  new URL('../../../../packages/harness/package.json', import.meta.url),
);
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { Effect, Fiber, Scheduler } = await load('effect');
const { SqlClient } = await load('effect/sql/SqlClient')
  .then((m) => ({ SqlClient: m }))
  .catch(async () => ({
    SqlClient: (await load('effect/unstable/sql')).SqlClient,
  }));
const { SqliteClient } = await load('@effect/sql-sqlite-node');

const run = (statements, prevent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS t (n INTEGER)`;
    let inside = false;
    let intrusions = 0;
    // A competing fiber that runs whenever the scheduler gives it a turn.
    const other = yield* Effect.forkChild(
      Effect.forever(
        Effect.sync(() => {
          if (inside) intrusions++;
        }),
      ),
    );
    yield* Effect.yieldNow;
    const body = Effect.gen(function* () {
      inside = true;
      for (let i = 0; i < statements; i++)
        yield* sql`INSERT INTO t VALUES (${i})`;
      inside = false;
    });
    const tx = sql.withTransaction(body);
    const started = performance.now();
    yield* prevent
      ? tx.pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true))
      : tx;
    const ms = performance.now() - started;
    yield* Fiber.interrupt(other);
    return { statements, prevent, intrusions, ms: Math.round(ms) };
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:' })));

for (const n of [90, 400, 5000])
  for (const prevent of [false, true])
    console.log(JSON.stringify(await Effect.runPromise(run(n, prevent))));
