/** Transport budgets, measured by scripts/measure-session-readers.mjs. These
 * bound auxiliary delivery/replay storage, not the canonical retained view. */
export const SESSION_FRAME_BYTES = 16 * 1024 * 1024;
/** Shared batching target and envelope headroom for a retained source row. */
export const SESSION_FRAME_TARGET_BYTES = 256 * 1024;
export const SESSION_FRAME_ROWS = 256;
export const SESSION_REPLAY_BYTES = 128 * 1024 * 1024;
export const SESSION_REPLAY_ROWS = 1_000_000;

/** UTF-8 bytes of the JSON wire representation, on either side of the port. */
export function sessionMessageBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** A reader fails explicitly; retained durable content is never truncated. */
export class SessionReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionReaderError';
  }
}

/** A reader may opt into a bounded auxiliary history read. */
export interface SessionReadBudget {
  readonly bytes: number;
  readonly rows: number;
}
