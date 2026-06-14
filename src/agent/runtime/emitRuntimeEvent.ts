/**
 * Single emit path for run/host progress events (SDK Step 7d follow-on F-1).
 *
 * Replaces scattered `bus.emit(...)` in `src/tools` so one fact has one emit
 * path and one name, resolving the target in priority order:
 *
 * 1. a host-path caller's `session.hostChannel` (set only by hosts that own a
 *    non-default session, e.g. a desktop window) — when present;
 * 2. otherwise the active run's `runtimeHost`, resolved from the ambient
 *    {@link RunContext} (the in-run case — tools firing inside a run's ALS);
 * 3. otherwise the process {@link bus} — the single-session fallback that keeps
 *    the extension byte-identical (its run `runtimeHost.emit` is `bus.emit`
 *    anyway) and host-path callers that pass no session unchanged.
 *
 * In-run callers pass no `session` (the ALS supplies the run host). Host-path
 * callers — reachable outside any run ALS — MUST pass their owning `session`,
 * or the event resolves to the bus and a non-default session never sees it.
 */
import { bus, type ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import { tryUseRunContext } from './RunContext';
import type { SessionHandle } from './SessionHandle';

export function emitRuntimeEvent<K extends keyof ProgressEventPayloads>(
  event: K,
  payload: ProgressEventPayloads[K],
  session?: SessionHandle,
): void {
  const host = session?.hostChannel ?? tryUseRunContext()?.runtimeHost;
  if (host) host.emit(event, payload);
  else bus.emit(event, payload);
}
