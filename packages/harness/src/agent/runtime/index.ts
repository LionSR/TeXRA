/**
 * Agent runtime — what the hosts (CLI, desktop, extension) still take from
 * `packages/harness/src/agent/runtime` that the public `Session` does not
 * carry yet: the session handle and the engine helpers over it. It is the
 * single door the harness deep-import ratchet
 * (`config/ratchets/harness-deep-import-baseline.json`) allows each host.
 *
 * It is the hosts' one internal door, not SDK surface: it stays for the
 * record reads the handle serves, the presentation host class
 * (`SessionHostInteractions`) and the desktop's `Runs.launch`, which no
 * public entry carries (lead ruling G12b; public record reads are post-1.0,
 * on an embedder's need). Its names are frozen shrink-only by
 * `config/api-reports/harness.agent-runtime.api.md`: a new one fails
 * `check:core-quality`. Everything a host can take from a public entry
 * (`@texra-ai/harness`, `./schemas`) comes from there instead. Internal
 * runtime modules import each other by direct path; nothing inside
 * `src/agent` imports this barrel, so it introduces no import cycle.
 */

// The session handle: the record reads, the run log and the view a host
// still reads from it.
export type { SessionHandle, SessionViewAccess } from './SessionHandle';

// The process's one route retry gate, which a helper call reads from context.
export type { RouteRetries } from './run/invocation';

// A host's presentation surface on a handle, and the `SessionHostInteractions`
// a host with no session of its own presents through.
export type { HostInteractions } from './HostInteractions';
export { SessionHostInteractions } from './HostInteractions';

// What `Runs.launch` takes: the desktop's launch still goes through it.
export type { RootLaunchRequest } from './rootLaunch';

// Whether a run can be resumed here, naming the process holding it.
export { runRefusal } from './runClassification';

// A launch failure's presentation, once.
export {
  presentRunFailure,
  terminalFailurePresented,
} from './terminalResultToast';

// A host's emit handlers, one per presentation event.
export type { PresentationEventHandlers } from './runtimePresentationEvents';

// The helper model the "fix LaTeX" actions run on.
export { getHelperModelName } from './helperModelName';

// Run-request validation at the host launch boundary.
export {
  validateRunRequest,
  type ValidatedRunRequest,
} from '../core/state/runRequests';

// A workflow run's delivered outputs with their diffs, for a host that prints them.
export { withWorkflowDiffs } from './subagentResults';
