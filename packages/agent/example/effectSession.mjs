/**
 * A tiny embedder of `@texra-ai/agent/effect`, installed from a packed
 * tarball exactly as a consumer off the registry would get it: the import
 * specifiers below are package names, never this repository's path aliases.
 *
 * It needs no provider key. It composes the runtime, opens a session, reads
 * the session's current view level, lists what the owner holds, and asks for
 * an agent that does not exist so the typed refusal is visible. Leaving the
 * scope closes the session and disposes the runtime that held it.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Stream } from 'effect';
import { Runtime, Sessions } from '@texra-ai/agent/effect';
import { nodePlatform } from '@texra-ai/agent/node';

const workspace = await mkdtemp(join(tmpdir(), 'texra-agent-example-'));
const agentsDir = join(workspace, 'agents');
await mkdir(agentsDir, { recursive: true });

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open();
  console.log('session root:', session.roots.storage);

  const level = yield* Stream.runHead(session.view.changes);
  console.log(
    'first view level:',
    level._tag === 'Some' ? `${level.value.streams.size} streams` : 'none',
  );

  const open = yield* sessions.list;
  console.log('sessions the owner holds:', open.length);

  // `start` fails with a tagged error rather than a thrown string: an
  // embedder branches on `_tag`.
  const refusal = yield* Effect.flip(
    session.start({ agent: 'no-such-agent', instruction: 'Nothing to do.' }),
  );
  console.log(`refusal: ${refusal._tag} - ${refusal.message}`);
}).pipe(
  Effect.scoped,
  Effect.provide(
    Runtime.layer(
      nodePlatform({
        agentsDir,
        storageDir: join(workspace, 'storage'),
        workspaceDir: workspace,
      }),
    ),
  ),
);

await Effect.runPromise(program);
console.log('done');
