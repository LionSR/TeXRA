/**
 * The process's session owner, as the tag `src/agent`, the SDK entry and the
 * hosts reach it by: one session per workspace storage root, served by
 * `processLayer` (`@controllers/session/sessionLayer`) over the `LayerMap`
 * that owns every session's lifetime. `src/agent` never imports
 * `src/controllers`, so the tag lives here; its shape is
 * {@link SessionOwnerShape}.
 */
import { Context } from 'effect';

import type { SessionOwnerShape } from './SessionHandle';

/** The process's session owner (see {@link SessionOwnerShape}). */
export class SessionOwner extends Context.Service<
  SessionOwner,
  SessionOwnerShape
>()('@texra-ai/harness/SessionOwner') {}
