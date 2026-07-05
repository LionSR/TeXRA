// Full-state reset between CLI sessions (e.g. `/clear`), plus the hook
// registry other state modules use to reset their own signals in step.

import { defaultSessionMeta, SESSION_META } from './sessionSlice';
import {
  ACTIVE_STREAM_ID,
  ROOT_RUN_START_AVAILABLE,
  ROOT_STREAM_ID,
} from './focusSlice';
import { STREAMS } from './streamsSlice';
import { PARENT_STREAM } from './parentStreamSlice';
import {
  ACTIVE_FORM,
  CHILD_CONTROL_ESCAPE_ACTION,
  CHILD_CONTROL_MODE,
  REVERSE_SEARCH_OPEN,
  SLASH_PALETTE_OPEN,
  TRANSCRIPT_VIEWER_STREAM_ID,
} from './foregroundOverlaySlice';
import { PENDING_EXIT_HINT, PENDING_EXIT_RESUME_ID } from './exitHintSlice';
import type { SessionMeta } from './types';

const RESET_HOOKS = new Set<() => void>();

export function registerCliStateResetHook(resetHook: () => void): void {
  RESET_HOOKS.add(resetHook);
}

export function resetCliState(
  sessionMeta: SessionMeta = defaultSessionMeta(),
): void {
  SESSION_META.set(sessionMeta);
  ACTIVE_STREAM_ID.set(undefined);
  ROOT_STREAM_ID.set(undefined);
  STREAMS.set(new Map());
  ROOT_RUN_START_AVAILABLE.set(true);
  PARENT_STREAM.set(new Map());
  ACTIVE_FORM.set(undefined);
  SLASH_PALETTE_OPEN.set(false);
  REVERSE_SEARCH_OPEN.set(false);
  TRANSCRIPT_VIEWER_STREAM_ID.set(undefined);
  CHILD_CONTROL_MODE.set(undefined);
  CHILD_CONTROL_ESCAPE_ACTION.set('close');
  PENDING_EXIT_HINT.set(false);
  PENDING_EXIT_RESUME_ID.set(undefined);
  for (const resetHook of RESET_HOOKS) resetHook();
}
