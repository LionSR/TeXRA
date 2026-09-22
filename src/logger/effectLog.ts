/**
 * Channel-annotated diagnostics for code that can yield an Effect.
 *
 * `@logger/logUtils` is the same thing for the Promise-shaped subsystems that
 * cannot; both write one structured entry to the single host sink in
 * `@logger/logSink`, so a subsystem converting to Effect keeps its channel and
 * its payload without a host learning a second entry shape. A converted file
 * calls `Effect.log*` and names its channel once for the whole program rather
 * than threading a channel string through every helper, and attaches a payload
 * raw with `Effect.annotateLogs(self, { data })` — the write path in
 * `@logger/logSink` renders and bounds it once, for every host surface, so no
 * producer decides how much detail a surface shows.
 */
// Third-party imports
import { Effect } from 'effect';

// Local imports
import { LOG_CHANNEL } from '@logger/logSink';

/**
 * Name the channel every `Effect.log*` inside `self` belongs to. Annotations
 * nest, so a callee that names its own channel keeps it: this sets the channel
 * for the entries that don't.
 */
export const withLogChannel =
  (channel: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateLogs(self, { [LOG_CHANNEL]: channel });
