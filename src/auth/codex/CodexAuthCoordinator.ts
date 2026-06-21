/**
 * Factory that wires a {@link CodexSessionCoordinator} onto a secret store,
 * paralleling `createHostAuthCoordinator` for Supabase. The token bundle is
 * persisted under {@link CODEX_SESSION_SECRET_KEY}, deliberately outside the
 * `apiKey.<provider>` namespace.
 */
import { CODEX_SESSION_SECRET_KEY } from './codexConstants';
import {
  CodexSessionCoordinator,
  type CodexLogger,
  type CodexSessionStorage,
} from './CodexSessionCoordinator';

/** The minimal secret-store surface the coordinator needs (= PlatformSecrets). */
export interface CodexSecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CodexAuthCoordinatorInit {
  secrets: CodexSecretStore;
  log?: CodexLogger;
}

export function createCodexAuthCoordinator(
  init: CodexAuthCoordinatorInit,
): CodexSessionCoordinator {
  const storage: CodexSessionStorage = {
    get: () => init.secrets.get(CODEX_SESSION_SECRET_KEY),
    store: (value) => init.secrets.set(CODEX_SESSION_SECRET_KEY, value),
    delete: () => init.secrets.delete(CODEX_SESSION_SECRET_KEY),
  };
  return new CodexSessionCoordinator({ storage, log: init.log });
}
