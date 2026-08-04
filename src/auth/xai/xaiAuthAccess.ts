/**
 * Process-wide access to the xAI Grok OAuth coordinator, backed by
 * `platform().secrets`.
 */
import { tryPlatform } from '@platform/platform';

import {
  getSubscriptionSessionStatus,
  isSubscriptionSessionRoutable,
} from '../oauth/sessionAccess';
import { XAI_SESSION_SECRET_KEY } from './xaiConstants';
import {
  XaiSessionCoordinator,
  type XaiSessionStorage,
  type XaiSessionStatus,
} from './XaiSessionCoordinator';
import { XaiAuthError } from './xaiSessionTypes';

const CHANNEL = 'xaiAuth';

let singleton: XaiSessionCoordinator | null = null;

/**
 * The shared coordinator. Throws if the platform has not been initialized yet
 * (callers run after `initPlatform()`).
 */
export function xaiCoordinator(): XaiSessionCoordinator {
  if (singleton) return singleton;
  const platform = tryPlatform();
  if (!platform) {
    throw new Error('xAI auth used before the platform was initialized.');
  }
  const storage: XaiSessionStorage = {
    get: () => platform.secrets.get(XAI_SESSION_SECRET_KEY),
    store: (value) => platform.secrets.set(XAI_SESSION_SECRET_KEY, value),
    delete: () => platform.secrets.delete(XAI_SESSION_SECRET_KEY),
  };
  singleton = new XaiSessionCoordinator({ storage });
  return singleton;
}

/** Test seam: drop the cached coordinator. */
export function resetXaiCoordinator(): void {
  singleton = null;
}

/** Signed-in status, safe to call before platform init (returns signed-out). */
export async function getXaiStatus(): Promise<XaiSessionStatus> {
  return getSubscriptionSessionStatus(xaiCoordinator, CHANNEL, 'Grok');
}

/**
 * Whether subscription routing should use the stored session.
 */
export async function isXaiSessionRoutable(): Promise<boolean> {
  return isSubscriptionSessionRoutable(xaiCoordinator, XaiAuthError, 'Grok');
}
