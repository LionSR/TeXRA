// Ctrl-C-to-exit resume hint: whether the next exit should surface a resume
// id, and which run it points at.

import { signal } from '@lit-labs/signals';

const PENDING_EXIT_HINT = signal<boolean>(false);
const PENDING_EXIT_RESUME_ID = signal<string | undefined>(undefined);

/** Whether the next exit should surface a resume hint. */
export const pendingExitHint = PENDING_EXIT_HINT;
/** Which run the pending exit hint's resume id points at. */
export const pendingExitResumeId = PENDING_EXIT_RESUME_ID;
