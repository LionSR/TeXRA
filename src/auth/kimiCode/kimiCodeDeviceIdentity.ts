/**
 * Device identity for the Kimi Code OAuth backend.
 *
 * The auth.kimi.com token endpoints require `X-Msh-*` device-information
 * headers on every request (per kimi-cli's KLIP-14), keyed by a stable device
 * UUID. The UUID is an identifier, not a credential, so it lives in global
 * state rather than the secret store.
 */
import * as crypto from 'node:crypto';
import * as os from 'node:os';

import { tryGlobalState } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { KIMI_CODE_CLIENT_VERSION } from './kimiCodeConstants';

/** In-process fallback so headers stay stable even before platform init. */
let ephemeralDeviceId: string | null = null;

/** The persisted device UUID, generated once per installation. */
async function getKimiCodeDeviceId(): Promise<string> {
  const state = tryGlobalState();
  if (!state) {
    ephemeralDeviceId ??= crypto.randomUUID();
    return ephemeralDeviceId;
  }
  const existing = state.get<string>(GlobalStateKey.KIMI_CODE_DEVICE_ID);
  if (existing) return existing;
  const id = ephemeralDeviceId ?? crypto.randomUUID();
  await state.update(GlobalStateKey.KIMI_CODE_DEVICE_ID, id);
  return id;
}

/** Header values must be ASCII; strip anything else (hostnames can be UTF-8). */
function asciiHeaderValue(value: string): string {
  const cleaned = value.replaceAll(/[^\x20-\x7e]/g, '');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * The `X-Msh-*` device headers Kimi Code expects on token and inference
 * requests, mirroring kimi-cli's fingerprint shape.
 */
export async function kimiCodeClientHeaders(): Promise<
  Record<string, string>
> {
  return {
    'X-Msh-Platform': 'texra',
    'X-Msh-Version': KIMI_CODE_CLIENT_VERSION,
    'X-Msh-Device-Name': asciiHeaderValue(os.hostname()),
    'X-Msh-Device-Model': asciiHeaderValue(`${os.type()} ${os.release()} ${os.arch()}`),
    'X-Msh-Os-Version': asciiHeaderValue(os.release()),
    'X-Msh-Device-Id': await getKimiCodeDeviceId(),
  };
}
