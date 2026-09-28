/**
 * When the agent catalog's initial load has landed, and whether a remote
 * load has anything to add. Where a catalog follower runs
 * (`@tools/agentCatalogFollower`), its first reload is the catalog's
 * initial load, and `loadAgents` waits for it rather than scanning beside
 * it.
 */
import { Deferred, Effect, Exit } from 'effect';

import { SupabaseAuth } from '@auth/SupabaseAuth';

/** The follower's first load while it has not landed. */
let followerLoad: Deferred.Deferred<void> | undefined;

/**
 * Make the follower's first load the catalog's initial one, for the
 * caller's scope: the effect returned marks it landed (whatever its
 * outcome), and so does the scope's close, so no load waits on a follower
 * that has stopped.
 */
export const followerOwnsInitialLoad = Effect.acquireRelease(
  Effect.sync(() => {
    const load = Deferred.makeUnsafe<void>();
    followerLoad = load;
    return Effect.andThen(
      Deferred.done(load, Exit.void),
      Effect.sync(() => {
        if (followerLoad === load) followerLoad = undefined;
      }),
    );
  }),
  (landed) => landed,
);

/** Wait for the follower's first load, if one is pending. */
export const untilFollowerLoaded = Effect.suspend(() =>
  followerLoad === undefined ? Effect.void : Deferred.await(followerLoad),
);

/**
 * An account plane is composed and nobody is signed in to it: the remote
 * catalog is empty, so a published local catalog is the whole one, and
 * signing in refreshes it with remote.
 */
export const signedOut = Effect.flatMap(
  Effect.serviceOption(SupabaseAuth),
  (auth) =>
    auth._tag === 'Some'
      ? Effect.map(auth.value.authenticated, (signedIn) => !signedIn)
      : Effect.succeed(false),
);
