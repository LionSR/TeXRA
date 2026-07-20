import type { ExecutionId } from '@shared/schemas';

/** A resumed execution lost its canonical admission race with deletion. */
export class ResumeAdmissionCancelledError extends Error {
  constructor(readonly executionId: ExecutionId) {
    super(`Resume cancelled before launch for execution ${executionId}.`);
    this.name = 'ResumeAdmissionCancelledError';
  }
}
