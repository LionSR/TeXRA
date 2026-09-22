import { Data, Effect } from 'effect';

import type { SignInFailed } from '@common/errors/signInFailed';

/**
 * A team-catalog port the host would not answer.
 *
 * The bag below is bound seven times across the three hosts and the setup
 * tool. `choose` and `commitPreset` reach host dialogs and stores, so each
 * raises this from its own host boundary instead of the identity-caught
 * `unknown` they used to propagate; `member` says which port refused, which
 * is the only distinction any caller here draws. `canAccessRemoteCatalog` is
 * an Effect over the account plane's own infallible probe, and `signIn` is an
 * `Effect` port carrying its own `SignInFailed` from the host boundary, so
 * neither has a failure to wrap here.
 *
 * A user's own answer is never this: `choose` reporting `undefined` and
 * `signIn` reporting `false` are values the preflight already reads.
 */
export class TeamCatalogPortFailed extends Data.TaggedError(
  'TeamCatalogPortFailed',
)<{
  readonly member: 'choose' | 'commitPreset';
  readonly message: string;
  readonly cause: unknown;
}> {}

export type TeamAvailabilityChoice = 'sign-in' | 'continue' | 'cancel';

export type TeamAvailabilityPreflightResult<T> =
  | { readonly status: 'proceed'; readonly value: T; readonly partial: boolean }
  | {
      readonly status: 'choice-required';
      readonly value: T;
      readonly unavailableNames: readonly string[];
    }
  | { readonly status: 'cancelled'; readonly value: T }
  | {
      readonly status: 'unavailable';
      readonly value: T;
      readonly unavailableNames: readonly string[];
    };

export interface TeamAvailabilityPreflightOptions<T, R = never> {
  readonly initial: T;
  readonly unresolvedNames: (value: T) => readonly string[];
  readonly texraHostedNames: ReadonlySet<string>;
  readonly canAccessRemoteCatalog: () => Effect.Effect<boolean>;
  /** A decision already supplied by a non-interactive caller. */
  readonly providedChoice?: TeamAvailabilityChoice;
  readonly choose: (
    unavailableNames: readonly string[],
  ) => Effect.Effect<TeamAvailabilityChoice | undefined, TeamCatalogPortFailed>;
  readonly signIn: () => Effect.Effect<boolean, SignInFailed>;
  /** Force a remote catalog refresh; the failure channel is the refresh's own. */
  readonly refreshRemote: () => Effect.Effect<void, unknown, R>;
  /** Recompute the planned value against the refreshed catalog. */
  readonly replan: () => Effect.Effect<T, Error, R>;
  /** The caller already forced a remote catalog fetch for `initial`. */
  readonly remoteCatalogRefreshAttempted?: boolean;
}

function unavailableTexraHostedNames<T, R>(
  value: T,
  options: TeamAvailabilityPreflightOptions<T, R>,
): string[] {
  return options
    .unresolvedNames(value)
    .filter((name) => options.texraHostedNames.has(name));
}

/**
 * Decide whether an incomplete team may proceed before its caller writes or
 * launches anything. Model credentials are deliberately absent from this API:
 * only TeXRA authentication can make TeXRA-hosted definitions available.
 */
export function preflightTeamAvailability<T, R = never>(
  options: TeamAvailabilityPreflightOptions<T, R>,
): Effect.Effect<TeamAvailabilityPreflightResult<T>, unknown, R> {
  return Effect.gen(function* () {
    const refreshAndRecheck = Effect.gen(function* () {
      yield* options.refreshRemote();
      const refreshed = yield* options.replan();
      const unavailableNames = unavailableTexraHostedNames(refreshed, options);
      return unavailableNames.length === 0
        ? { status: 'proceed' as const, value: refreshed, partial: false }
        : {
            status: 'unavailable' as const,
            value: refreshed,
            unavailableNames,
          };
    });

    const initialUnavailable = unavailableTexraHostedNames(
      options.initial,
      options,
    );
    if (initialUnavailable.length === 0) {
      return { status: 'proceed', value: options.initial, partial: false };
    }

    if (options.providedChoice === 'cancel') {
      return { status: 'cancelled', value: options.initial };
    }
    if (options.providedChoice === 'continue') {
      return { status: 'proceed', value: options.initial, partial: true };
    }

    const canAccessRemoteCatalog = yield* options.canAccessRemoteCatalog();
    if (canAccessRemoteCatalog) {
      if (options.remoteCatalogRefreshAttempted) {
        return {
          status: 'unavailable',
          value: options.initial,
          unavailableNames: initialUnavailable,
        };
      }
      return yield* refreshAndRecheck;
    }

    const choice =
      options.providedChoice ?? (yield* options.choose(initialUnavailable));
    if (choice === undefined) {
      return {
        status: 'choice-required',
        value: options.initial,
        unavailableNames: initialUnavailable,
      };
    }
    if (choice === 'cancel') {
      return { status: 'cancelled', value: options.initial };
    }
    if (choice === 'continue') {
      return { status: 'proceed', value: options.initial, partial: true };
    }

    const signedIn = yield* options.signIn();
    if (!signedIn) {
      return { status: 'cancelled', value: options.initial };
    }

    return yield* refreshAndRecheck;
  });
}
