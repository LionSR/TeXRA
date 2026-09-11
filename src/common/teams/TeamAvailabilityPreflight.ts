import { Effect } from 'effect';

import { hostPort } from '@common/hostPort';

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

export interface TeamAvailabilityPreflightOptions<T> {
  readonly initial: T;
  readonly unresolvedNames: (value: T) => readonly string[];
  readonly texraHostedNames: ReadonlySet<string>;
  readonly canAccessRemoteCatalog: () => Promise<boolean>;
  /** A decision already supplied by a non-interactive caller. */
  readonly providedChoice?: TeamAvailabilityChoice;
  readonly choose: (
    unavailableNames: readonly string[],
  ) => Promise<TeamAvailabilityChoice | undefined>;
  readonly signIn: () => Promise<boolean>;
  /** Force a remote catalog refresh; the failure channel is the refresh's own. */
  readonly refreshRemote: () => Effect.Effect<void, unknown>;
  /** Recompute the planned value against the refreshed catalog. */
  readonly replan: () => T;
  /** The caller already forced a remote catalog fetch for `initial`. */
  readonly remoteCatalogRefreshAttempted?: boolean;
}

function unavailableTexraHostedNames<T>(
  value: T,
  options: TeamAvailabilityPreflightOptions<T>,
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
export function preflightTeamAvailability<T>(
  options: TeamAvailabilityPreflightOptions<T>,
): Effect.Effect<TeamAvailabilityPreflightResult<T>, unknown> {
  return Effect.gen(function* () {
    const refreshAndRecheck = Effect.gen(function* () {
      yield* options.refreshRemote();
      const refreshed = yield* Effect.try({
        try: () => options.replan(),
        catch: (error) => error,
      });
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

    const canAccessRemoteCatalog = yield* hostPort(() =>
      options.canAccessRemoteCatalog(),
    );
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
      options.providedChoice ??
      (yield* hostPort(() => options.choose(initialUnavailable)));
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

    if (!(yield* hostPort(() => options.signIn()))) {
      return { status: 'cancelled', value: options.initial };
    }

    return yield* refreshAndRecheck;
  });
}
