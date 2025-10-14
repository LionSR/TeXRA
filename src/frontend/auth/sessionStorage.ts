// Third-party imports
import * as vscode from 'vscode';

// Local imports - secrets
import { SecretManager } from '@frontend/secretManager';

const ACCESS_TOKEN_KEY = 'auth.supabase.accessToken';
const REFRESH_TOKEN_KEY = 'auth.supabase.refreshToken';
const PROXY_TOKEN_KEY = 'auth.supabase.proxyToken';
const PROXY_EXPIRY_KEY = 'auth.supabase.proxyExpiry';
const PROXY_SESSION_ID_KEY = 'auth.supabase.proxySessionId';

export interface StoredSupabaseSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface StoredProxySession {
  token: string;
  expiresAt?: string;
  sessionId?: string;
}

async function setSecret(
  key: string,
  value: string | undefined,
): Promise<void> {
  if (!value) {
    await SecretManager.delete(key);
    return;
  }
  await SecretManager.set(key, value);
}

export async function saveSupabaseSession(
  session: StoredSupabaseSession | undefined,
): Promise<void> {
  if (!session) {
    await Promise.all([
      SecretManager.delete(ACCESS_TOKEN_KEY),
      SecretManager.delete(REFRESH_TOKEN_KEY),
    ]);
    return;
  }

  const operations: Array<Promise<void>> = [
    SecretManager.set(ACCESS_TOKEN_KEY, session.accessToken),
  ];

  if (session.refreshToken) {
    operations.push(SecretManager.set(REFRESH_TOKEN_KEY, session.refreshToken));
  } else {
    operations.push(SecretManager.delete(REFRESH_TOKEN_KEY));
  }

  await Promise.all(operations);
}

export async function loadSupabaseSession(): Promise<
  StoredSupabaseSession | undefined
> {
  const accessToken = await SecretManager.get(ACCESS_TOKEN_KEY);
  if (!accessToken) {
    return undefined;
  }

  const refreshToken = await SecretManager.get(REFRESH_TOKEN_KEY);
  const expiresAt = process.env.SUPABASE_ACCESS_EXPIRES_AT;

  return {
    accessToken,
    refreshToken: refreshToken ?? undefined,
    expiresAt: expiresAt ?? undefined,
  };
}

export async function clearSupabaseSession(): Promise<void> {
  await Promise.all([
    SecretManager.delete(ACCESS_TOKEN_KEY),
    SecretManager.delete(REFRESH_TOKEN_KEY),
    SecretManager.delete(PROXY_TOKEN_KEY),
    SecretManager.delete(PROXY_EXPIRY_KEY),
    SecretManager.delete(PROXY_SESSION_ID_KEY),
  ]);
}

export async function saveProxySession(
  session: StoredProxySession | undefined,
): Promise<void> {
  if (!session) {
    await Promise.all([
      SecretManager.delete(PROXY_TOKEN_KEY),
      SecretManager.delete(PROXY_EXPIRY_KEY),
      SecretManager.delete(PROXY_SESSION_ID_KEY),
    ]);
    return;
  }

  const tasks: Array<Promise<void>> = [
    SecretManager.set(PROXY_TOKEN_KEY, session.token),
  ];

  tasks.push(setSecret(PROXY_EXPIRY_KEY, session.expiresAt));
  tasks.push(setSecret(PROXY_SESSION_ID_KEY, session.sessionId));

  await Promise.all(tasks);
}

export async function loadProxySession(): Promise<
  StoredProxySession | undefined
> {
  const token = await SecretManager.get(PROXY_TOKEN_KEY);
  if (!token) {
    return undefined;
  }

  const expiresAt = await SecretManager.get(PROXY_EXPIRY_KEY);
  const sessionId = await SecretManager.get(PROXY_SESSION_ID_KEY);

  return {
    token,
    expiresAt: expiresAt ?? undefined,
    sessionId: sessionId ?? undefined,
  };
}

export function scheduleRefresh(
  callback: () => Promise<void>,
  expiresAt?: string,
  windowMinutes = 5,
): vscode.Disposable | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const expireDate = new Date(expiresAt);
  if (Number.isNaN(expireDate.getTime())) {
    return undefined;
  }

  const now = Date.now();
  const refreshMs = expireDate.getTime() - now - windowMinutes * 60 * 1000;
  if (refreshMs <= 0) {
    void callback();
    return undefined;
  }

  const timer = setTimeout(() => {
    void callback();
  }, refreshMs);

  return new vscode.Disposable(() => {
    clearTimeout(timer);
  });
}
