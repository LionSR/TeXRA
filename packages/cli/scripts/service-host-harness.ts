// Validation harness: a window with no editor that attaches to the running
// TeXRA service offering `readDiagnostics`, the way an extension window
// does. `answer` answers each read with one diagnostic naming the file;
// `hang` never answers, so the validator can detach it mid-call. It prints
// `ATTACHED` once its attachment is up, `LINKED` each time its link
// reaches a service (a restart prints it again), and `CALLED <path>` per
// read, and runs until it is killed. `approve` approves one pending request
// instead, as another window's Approve does (with `content`, the proposed
// file as that window left it), prints `DECIDED` or `REFUSED <tag>:
// <reason>`, and exits.
//
//   node service-host-harness.js <storageRoot> <workspace> <answer|hang>
//   node service-host-harness.js <storageRoot> <workspace> approve <runId> <requestId> [content]

import path from 'node:path';

import { Effect, Layer, Option, Predicate, Schema, Stream } from 'effect';

import { GlobalValues } from '@texra-ai/harness/host';
import { nodePlatformServices } from '@texra-ai/harness/node';
import { RunIdSchema } from '@texra-ai/harness/schemas';
import { globalDatabaseLayer } from '@controllers/session/databaseLayer';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import { GlobalDatabase } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import {
  linkService,
  requestOnService,
  type ServiceLink,
} from '@texra/controllers/server/client';
import { attachWindowHost } from '@texra/controllers/server/windowHost';

const [storageRoot, workspace, mode, ...rest] = process.argv.slice(2);
if (storageRoot === undefined || workspace === undefined)
  throw new Error(
    'usage: service-host-harness <storageRoot> <workspace> <answer|hang|approve>',
  );

/** The storage root's global values, where the service's record is. */
const globalValues = Layer.effect(
  GlobalValues,
  Effect.map(GlobalDatabase, (database) => database.values),
).pipe(
  Layer.provide(globalDatabaseLayer(resolveGlobalStoragePath(storageRoot))),
  Layer.provide(ProcessIdentity.layer(processOwnerId(undefined))),
  Layer.provide(nodePlatformServices),
  Layer.orDie,
);

const say = (line: string) =>
  Effect.sync(() => process.stdout.write(`${line}\n`));

/** The approval `rest` names, sent once the link reaches the service. */
const approve = (link: ServiceLink) => {
  const [runId, requestId, content] = rest;
  if (runId === undefined || requestId === undefined)
    throw new Error('usage: approve <runId> <requestId> [content]');
  return link.client.changes.pipe(
    Stream.filter(Predicate.isNotNull),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.flatMap((client) =>
      requestOnService(client, workspace, {
        kind: 'request.decide',
        runId: Schema.decodeUnknownSync(RunIdSchema)(runId),
        requestId,
        decision: {
          action: 'approve',
          ...(content !== undefined && { content }),
        },
      }),
    ),
    Effect.matchEffect({
      onFailure: (error) =>
        say(
          `REFUSED ${error._tag}: ${'reason' in error ? error.reason : error.message}`,
        ),
      onSuccess: () => say('DECIDED'),
    }),
  );
};

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const link = yield* linkService(
        {
          storageRoot,
          start: Effect.fail(
            new Error('The harness attaches to a running service only.'),
          ),
        },
        Effect.logWarning,
      );
      if (mode === 'approve') return yield* approve(link);
      yield* Effect.forkScoped(
        Stream.runForEach(link.client.changes, (client) =>
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
  ).pipe(Effect.provide(globalValues)),
);
