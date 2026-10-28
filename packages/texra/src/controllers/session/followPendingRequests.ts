/**
 * Run one program for each pending request a host follows, for as long as
 * the session's view lists it. A program that holds something for its
 * request (a preview, a staged card) ends with `Effect.never` and releases
 * it in a finalizer, which runs once the view drops the request, however it
 * was decided. A program that returns early runs again on the next view in
 * which the request is still listed.
 */
import { Effect, FiberMap, type Scope, Stream } from 'effect';

import type { Session } from '@texra-ai/harness';
import type { PendingRequest } from '@texra-ai/harness/schemas';

export const followPendingRequests = <P extends PendingRequest, R>(
  view: Pick<Session['view'], 'changes'>,
  select: (request: PendingRequest) => request is P,
  program: (request: P) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<string>();
    yield* Stream.runForEach(view.changes, (level) => {
      const pending = level.requests.filter(select);
      const listed = new Set(pending.map((request) => request.requestId));
      return Effect.forEach(
        [...fibers].filter(([requestId]) => !listed.has(requestId)),
        ([requestId]) => FiberMap.remove(fibers, requestId),
        { discard: true },
      ).pipe(
        Effect.andThen(
          Effect.forEach(
            pending,
            (request) =>
              FiberMap.run(fibers, request.requestId, program(request), {
                onlyIfMissing: true,
              }),
            { discard: true },
          ),
        ),
      );
    });
  });
