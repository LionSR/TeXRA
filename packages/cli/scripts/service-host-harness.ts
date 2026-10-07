// Validation harness: a window with no editor that attaches to the running
// TeXRA service offering `readDiagnostics`, the way an extension window
// does. `answer` answers each read with one diagnostic naming the file;
// `hang` never answers, so the validator can detach it mid-call. It prints
// `ATTACHED` once its attachment is up, `LINKED` each time its link
// reaches a service (a restart prints it again), and `CALLED <path>` per
// read, and runs until it is killed.
//
//   node service-host-harness.js <storageRoot> <workspace> <answer|hang>

import path from 'node:path';

import { Effect, Stream, SubscriptionRef } from 'effect';

import { linkService } from '@texra/controllers/server/client';
import { attachWindowHost } from '@texra/controllers/server/windowHost';

const [storageRoot, workspace, mode] = process.argv.slice(2);
if (storageRoot === undefined || workspace === undefined)
  throw new Error(
    'usage: service-host-harness <storageRoot> <workspace> <answer|hang>',
  );

const say = (line: string) =>
  Effect.sync(() => process.stdout.write(`${line}\n`));

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const link = yield* linkService(
        storageRoot,
        Effect.fail(
          new Error('The harness attaches to a running service only.'),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(SubscriptionRef.changes(link.client), (client) =>
          client === null ? Effect.void : say('LINKED'),
        ),
      );
      yield* attachWindowHost(
        link,
        workspace,
        {
          readDiagnostics: (file) =>
            say(`CALLED ${file}`).pipe(
              Effect.andThen(
                mode === 'hang'
                  ? Effect.never
                  : Effect.succeed([
                      {
                        severity: 0 as const,
                        message: `HARNESS-DIAG in ${path.basename(file)}`,
                        range: {
                          start: { line: 2, character: 0 },
                          end: { line: 2, character: 4 },
                        },
                      },
                    ]),
              ),
            ),
        },
        Stream.empty,
      );
      // The attachment is a stream the service opens on its side: give it
      // a moment before a task asks for it.
      yield* Effect.sleep('1 second');
      yield* say('ATTACHED');
      return yield* Effect.never;
    }),
  ),
);
