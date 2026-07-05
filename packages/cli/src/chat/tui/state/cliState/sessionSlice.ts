// Session-identity slice: the agent/model/cwd/approval snapshot for the
// current CLI session. One signal, no cross-stream concerns.

import { signal } from '@lit-labs/signals';

import type { SessionMeta } from './types';

const EMPTY_SESSION_META: SessionMeta = {
  agent: '',
  model: '',
  modelSource: 'builtin-default',
  cwd: '',
  apiMode: 'personal',
  approvalPolicy: 'ask',
  canDelegate: false,
  version: '',
};

const SESSION_META = signal<SessionMeta>(EMPTY_SESSION_META);

/** Agent/model/cwd/approval snapshot for the current CLI session. */
export const sessionMeta = SESSION_META;

export function patchSessionMeta(patch: Partial<SessionMeta>): void {
  SESSION_META.set({ ...SESSION_META.get(), ...patch });
}

export function setCliSessionModelOverride(model: string): void {
  patchSessionMeta({ model, modelSource: 'explicit-override' });
}

/** Preserve the resolved CLI version across resets; everything else clears. */
export function defaultSessionMeta(): SessionMeta {
  return { ...EMPTY_SESSION_META, version: SESSION_META.get().version };
}
