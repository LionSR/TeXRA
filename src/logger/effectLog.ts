/**
 * Channel-annotated diagnostics for code that can yield an Effect.
 *
 * `@logger/logUtils` is the same thing for the Promise-shaped subsystems that
 * cannot; both write one structured entry to the single host sink in
 * `@logger/logSink`, so a subsystem converting to Effect keeps its channel and
 * its debug payload without a host learning a second entry shape. A converted
 * file calls `Effect.log*` and names its channel once for the whole program
 * rather than threading a channel string through every helper.
 *
 * The one behavioural difference is the Effect logger's own, not this
 * module's: `effectDiagnosticsLayer` drops `Debug` and `Trace` entries unless
 * `texra.logger.debugMode` is on, where `logUtils` emits them and lets the
 * host's level filter decide.
 */
// Third-party imports
import { Effect } from 'effect';

// Local imports
import { LOG_CHANNEL } from '@logger/logSink';
import { formatLogData, isDebugModeEnabled } from '@logger/logUtils';

/**
 * Name the channel every `Effect.log*` inside `self` belongs to. Annotations
 * nest, so a callee that names its own channel keeps it: this sets the channel
 * for the entries that don't.
 */
export const withLogChannel =
  (channel: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateLogs(self, { [LOG_CHANNEL]: channel });

/**
 * Attach a debug payload to the entries inside `self`, on the same terms as
 * `createLog`'s `{ data }` option: rendered with Errors flattened, and only
 * when debug mode is on, so an ordinary session's diagnostics stay readable.
 * The setting is read when the effect runs, not when it is built, so a program
 * composed once still honours a mode the user changed since.
 */
export const withLogData =
  (data: unknown) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    data == null
      ? self
      : Effect.suspend(() =>
          isDebugModeEnabled()
            ? Effect.annotateLogs(self, { data: formatLogData(data) })
            : self,
        );
