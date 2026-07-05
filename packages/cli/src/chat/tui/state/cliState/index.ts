// Signal-backed state for the CLI TUI, composed from the slice modules in
// this directory. This barrel is the single public surface every other file
// imports (`from '.../state/cliState'`) — the split into slices is an
// internal reorganization, not a change to what's exported.

import type { StreamTabId } from '@shared/schemas';

import {
  ACTIVE_FORM,
  CHILD_CONTROL_ESCAPE_ACTION,
  CHILD_CONTROL_MODE,
  REVERSE_SEARCH_OPEN,
  SLASH_PALETTE_OPEN,
  TRANSCRIPT_VIEWER_STREAM_ID,
  type ActiveSlashForm,
} from './foregroundOverlaySlice';
import { CODEX_PREFERENCE_VERSION } from './codexPreferenceSlice';
import { PENDING_EXIT_HINT, PENDING_EXIT_RESUME_ID } from './exitHintSlice';
import {
  ACTIVE_STREAM_ID,
  ROOT_RUN_START_AVAILABLE,
  ROOT_STREAM_ID,
} from './focusSlice';
import { PARENT_STREAM } from './parentStreamSlice';
import { SESSION_META } from './sessionSlice';
import { STREAMS } from './streamsSlice';
import type { ChildControlMode } from '../childControls';
import type { Signal } from '@lit-labs/signals';
import type { SessionMeta, StreamSlice } from './types';

export const cliState = {
  sessionMeta: SESSION_META as Signal.State<SessionMeta>,
  activeStreamId: ACTIVE_STREAM_ID as Signal.State<StreamTabId | undefined>,
  rootStreamId: ROOT_STREAM_ID as Signal.State<StreamTabId | undefined>,
  streams: STREAMS as Signal.State<ReadonlyMap<StreamTabId, StreamSlice>>,
  rootRunStartAvailable: ROOT_RUN_START_AVAILABLE as Signal.State<boolean>,
  parentStream: PARENT_STREAM as Signal.State<
    ReadonlyMap<StreamTabId, StreamTabId>
  >,
  activeForm: ACTIVE_FORM as Signal.State<ActiveSlashForm | undefined>,
  slashPaletteOpen: SLASH_PALETTE_OPEN as Signal.State<boolean>,
  reverseSearchOpen: REVERSE_SEARCH_OPEN as Signal.State<boolean>,
  transcriptViewerStreamId: TRANSCRIPT_VIEWER_STREAM_ID as Signal.State<
    StreamTabId | undefined
  >,
  childControlMode: CHILD_CONTROL_MODE as Signal.State<
    ChildControlMode | undefined
  >,
  childControlEscapeAction: CHILD_CONTROL_ESCAPE_ACTION as Signal.State<string>,
  pendingExitHint: PENDING_EXIT_HINT as Signal.State<boolean>,
  pendingExitResumeId: PENDING_EXIT_RESUME_ID as Signal.State<
    string | undefined
  >,
  codexPreferenceVersion: CODEX_PREFERENCE_VERSION as Signal.State<number>,
};

export type {
  BypassState,
  CompletedProcessTranscript,
  ConversationEntry,
  ProcessOutputTail,
  SessionMeta,
  StreamSlice,
} from './types';
export { NO_BYPASS, thinkingIndicatorVisible } from './types';
export type { ActiveSlashForm } from './foregroundOverlaySlice';

export { patchSessionMeta, setCliSessionModelOverride } from './sessionSlice';
export { patchStream, setStreamStatusInCliState } from './streamsSlice';
export { registerChildStreams, setParentStream } from './parentStreamSlice';
export { bumpCodexPreferenceVersion } from './codexPreferenceSlice';
export { removeStream } from './removeStream';
export { registerCliStateResetHook, resetCliState } from './reset';
