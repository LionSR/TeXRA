// Test-only lifecycle driver for the CLI TUI's stream view.
//
// The default session's `StreamStatusMachine` is the single owner of a
// stream's phase, substate, and run window; CLI renderers read it through
// `streamPhaseFor`, which refuses an identity this state lifetime has no
// slice for. Suites that only need a stream to *be* in a phase drive both
// here instead of restating that pairing at every call site — transition and
// ordering coverage still belongs to the substrate suites and the
// adapter-driven matrix in TuiStateAndFocus.vitest.ts.

import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { patchStream } from '@cli/chat/tui/state/cliState';
import type { StreamPhase, StreamSubstate, StreamTabId } from '@shared/schemas';

import { seedStreamStatusForTest } from './streamStatusTestUtils';

/** Put one stream in a lifecycle phase and mint the view slice that makes it
 *  paintable, the way an applied `status` fact does in production. */
export function setCliStreamPhase(init: {
  readonly streamId: StreamTabId;
  readonly status: StreamPhase;
  readonly substate?: StreamSubstate;
  readonly runStartedAt?: number;
  /** Session owning the machine the CLI reads. Defaults to the process
   *  default session; a suite that attaches the signals adapter to a session
   *  of its own must name that one. */
  readonly session?: SessionHandle;
}): void {
  seedStreamStatusForTest(
    (init.session ?? defaultSession()).status,
    init.streamId,
    {
      phase: init.status,
      ...(init.substate ? { substate: init.substate } : {}),
      ...(init.runStartedAt !== undefined
        ? { runStartedAt: init.runStartedAt }
        : {}),
    },
  );
  patchStream(init.streamId, (slice) => ({ ...slice }));
}
