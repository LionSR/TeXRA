// Full-state reset between CLI sessions (e.g. `/clear`), plus the hook
// registry other state modules use to reset their own signals in step.

import {
  defaultSessionMeta,
  sessionMeta as sessionMetaSignal,
} from './sessionSlice';
import {
  activeStreamId,
  rootRunStartAvailable,
  rootStreamId,
} from './focusSlice';
import { streams } from './streamsSlice';
import { parentStream } from './parentStreamSlice';
import {
  activeForm,
  childControlEscapeAction,
  childControlMode,
  reverseSearchOpen,
  slashPaletteOpen,
  transcriptViewerStreamId,
} from './foregroundOverlaySlice';
import { pendingExitHint, pendingExitResumeId } from './exitHintSlice';
import type { SessionMeta } from './types';

const RESET_HOOKS = new Set<() => void>();

export function registerCliStateResetHook(resetHook: () => void): void {
  RESET_HOOKS.add(resetHook);
}

export function resetCliState(
  nextSessionMeta: SessionMeta = defaultSessionMeta(),
): void {
  sessionMetaSignal.set(nextSessionMeta);
  activeStreamId.set(undefined);
  rootStreamId.set(undefined);
  streams.set(new Map());
  rootRunStartAvailable.set(true);
  parentStream.set(new Map());
  activeForm.set(undefined);
  slashPaletteOpen.set(false);
  reverseSearchOpen.set(false);
  transcriptViewerStreamId.set(undefined);
  childControlMode.set(undefined);
  childControlEscapeAction.set('close');
  pendingExitHint.set(false);
  pendingExitResumeId.set(undefined);
  for (const resetHook of RESET_HOOKS) resetHook();
}
