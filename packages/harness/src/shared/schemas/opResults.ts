/**
 * What closing a session ended, and what it did not: the answer of the
 * session owner's close (`Sessions.close`, the SDK's `closeSession`). New
 * executions were refused and the owned live ones interrupted. `abandoned`
 * names the executions still live when the close budget ran out, empty when
 * every one ended inside it: the session stays open, refusing new work,
 * until they actually end, and the caller must not treat a close with
 * abandoned executions as complete disposal.
 */
export interface SessionCloseReport {
  readonly abandoned: readonly string[];
}
