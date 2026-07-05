// Which stream is focused / rooted, and whether starting a new root run is
// currently available. No update logic beyond plain get/set lives here —
// stream-lifecycle side effects that touch these signals alongside others
// (e.g. `removeStream`) live in `./removeStream`.

import { signal } from '@lit-labs/signals';

import type { StreamTabId } from '@shared/schemas';

const ACTIVE_STREAM_ID = signal<StreamTabId | undefined>(undefined);
const ROOT_STREAM_ID = signal<StreamTabId | undefined>(undefined);
const ROOT_RUN_START_AVAILABLE = signal<boolean>(true);

/** The stream currently focused in the transcript / status bar. */
export const activeStreamId = ACTIVE_STREAM_ID;
/** The top-level stream the current session rooted at. */
export const rootStreamId = ROOT_STREAM_ID;
/** Whether starting a new root run is currently available. */
export const rootRunStartAvailable = ROOT_RUN_START_AVAILABLE;
