// Which stream is focused / rooted, and whether starting a new root run is
// currently available. No update logic beyond plain get/set lives here —
// stream-lifecycle side effects that touch these signals alongside others
// (e.g. `removeStream`) live in `./removeStream`.

import { signal } from '@lit-labs/signals';

import type { StreamTabId } from '@shared/schemas';

export const ACTIVE_STREAM_ID = signal<StreamTabId | undefined>(undefined);
export const ROOT_STREAM_ID = signal<StreamTabId | undefined>(undefined);
export const ROOT_RUN_START_AVAILABLE = signal<boolean>(true);
