/**
 * Factory that wires a {@link KimiCodeSessionCoordinator} onto a secret store,
 * paralleling `createCodexAuthCoordinator`. The token bundle is persisted
 * under {@link KIMI_CODE_SESSION_SECRET_KEY}, deliberately outside the
 * `apiKey.<provider>` namespace.
 */
import { KIMI_CODE_SESSION_SECRET_KEY } from './kimiCodeConstants';
import {
  KimiCodeSessionCoordinator,
  type KimiCodeLogger,
  type KimiCodeSessionStorage,
} from './KimiCodeSessionCoordinator';

/** The minimal secret-store surface the coordinator needs (= PlatformSecrets). */
interface KimiCodeSecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface KimiCodeAuthCoordinatorInit {
  secrets: KimiCodeSecretStore;
  log?: KimiCodeLogger;
}

export function createKimiCodeAuthCoordinator(
  init: KimiCodeAuthCoordinatorInit,
): KimiCodeSessionCoordinator {
  const storage: KimiCodeSessionStorage = {
    get: () => init.secrets.get(KIMI_CODE_SESSION_SECRET_KEY),
    store: (value) => init.secrets.set(KIMI_CODE_SESSION_SECRET_KEY, value),
    delete: () => init.secrets.delete(KIMI_CODE_SESSION_SECRET_KEY),
  };
  return new KimiCodeSessionCoordinator({ storage, log: init.log });
}
