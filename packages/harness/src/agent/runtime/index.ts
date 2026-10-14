/**
 * Agent runtime — what the hosts (CLI, desktop, extension) take from
 * `packages/harness/src/agent/runtime` that the public `Session` does not
 * carry: the session handle and the host-facing helpers over it, every
 * name with a host consumer. It is the
 * single door the harness deep-import ratchet
 * (`config/ratchets/harness-deep-import-baseline.json`) allows each host.
 *
 * It is the hosts' one internal door, not SDK surface: it stays for the
 * record reads the handle serves and the presentation host class
 * (`SessionHostInteractions`), which no public entry carries (lead ruling G12b; public record reads are post-1.0,
 * on an embedder's need). Its names are frozen shrink-only by
 * `config/api-reports/harness.agent-runtime.api.md`: a new one fails
 * `check:core-quality`. Everything a host can take from a public entry
 * (`@texra-ai/harness`, `./schemas`) comes from there instead. Internal
 * runtime modules import each other by direct path; nothing inside
 * `src/agent` imports this barrel, so it introduces no import cycle.
 */

// The session handle: the record reads, the run log and the view a host
// still reads from it.
export type { SessionHandle } from './SessionHandle';

// A host's presentation surface on a handle, and the `SessionHostInteractions`
// a host with no session of its own presents through.
export type { HostInteractions } from './HostInteractions';
export { SessionHostInteractions } from './HostInteractions';

// Whether a run can be resumed here, naming the process holding it.
export { runRefusal } from './runClassification';

// Whether a launch failure was already presented, so a host's own
// fallback does not print it twice.
export { terminalFailurePresented } from './terminalResultToast';

// A host's emit handlers, one per presentation event.
export type { PresentationEventHandlers } from './runtimePresentationEvents';
