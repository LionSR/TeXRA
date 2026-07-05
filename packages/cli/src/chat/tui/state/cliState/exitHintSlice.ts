// Ctrl-C-to-exit resume hint: whether the next exit should surface a resume
// id, and which run it points at.

import { signal } from '@lit-labs/signals';

export const PENDING_EXIT_HINT = signal<boolean>(false);
export const PENDING_EXIT_RESUME_ID = signal<string | undefined>(undefined);
