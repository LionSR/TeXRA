/**
 * Command constants for the odyssey view (per-stream autonomous-continuation
 * objective). Mirrors `memoryViewCommands.ts`.
 */
import { COMMON_COMMANDS } from './commonCommands';

export const ODYSSEY_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  GET_ODYSSEY_STATUS: 'getOdysseyStatus',
  GET_ODYSSEY_LIST: 'getOdysseyList',
  START_ODYSSEY: 'startOdyssey',
  PAUSE_ODYSSEY: 'pauseOdyssey',
  RESUME_ODYSSEY: 'resumeOdyssey',
  ABANDON_ODYSSEY: 'abandonOdyssey',
  EDIT_OBJECTIVE: 'editObjective',
  /** Outbound: backend → frontend */
  ODYSSEY_UPDATED: 'odysseyUpdated',
} as const;
