/**
 * The session's views as a host or an embedder reads them: the fold's own
 * shapes (`./sessionView`), read-only all the way down. Here, beside the
 * schema rather than in the root's declarations, so a browser reaches them
 * through `@texra-ai/harness/schemas`.
 */
import type { ReadonlyDeep } from './readonlyDeep';
import type { SessionViewSchema } from './sessionView';

/** One published level of the session's fold: an immutable value. */
export type SessionView = ReadonlyDeep<typeof SessionViewSchema.Type>;
/** One stream of the {@link SessionView}. */
export type RunView = ReadonlyDeep<
  (typeof SessionViewSchema.Type)['runs'] extends ReadonlyMap<
    unknown,
    infer Run
  >
    ? Run
    : never
>;
/** A stream's transcript slice: what hosts paint. */
export type TranscriptView = RunView['transcript'];
/** A request a run waits on a person for, as {@link SessionView} lists it:
 *  which run asks, the request's id, and its payload (`payload.kind` is
 *  what is asked: a command, an edit, a plan, a retry, a question). */
export type PendingRequest = SessionView['requests'][number];
