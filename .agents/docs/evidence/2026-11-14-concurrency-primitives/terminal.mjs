import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(
  new URL('../../../../packages/harness/package.json', import.meta.url),
);
const imp = (n) => import(pathToFileURL(require.resolve(n)).href);
const Effect = await imp('effect/Effect');
const Terminal = await imp('effect/Terminal');
const NodeTerminal = await imp('@effect/platform-node/NodeTerminal');
const mode = process.argv[2];
if (mode === 'effect') {
  const prog = Effect.gen(function* () {
    const t = yield* Terminal.Terminal;
    for (let i = 0; i < 3; i++) {
      const r = yield* Effect.exit(t.readLine);
      console.log('readLine', i, JSON.stringify(r));
    }
  }).pipe(Effect.provide(NodeTerminal.layer));
  await Effect.runPromise(prog);
  console.log('done');
} else {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const timer = setTimeout(() => {
    console.log('question never settled after 1500ms');
    process.exit(3);
  }, 1500);
  const a = await rl.question('q? ');
  clearTimeout(timer);
  console.log('answer', JSON.stringify(a));
  rl.close();
}
