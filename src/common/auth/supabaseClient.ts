// Third-party imports
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as vscode from 'vscode';

// Local imports - config and logging
import * as logger from '@logger/logUtils';
import { getConfig, updateConfig } from '@utils/config';
import {
  clearSupabaseSession,
  loadProxySession,
  loadSupabaseSession,
  saveProxySession,
  saveSupabaseSession,
  type StoredProxySession,
  type StoredSupabaseSession,
} from '@frontend/auth/sessionStorage';

const CHANNEL = 'supabaseAuth';
logger.initialize(CHANNEL);

export interface RemoteAgentDescriptor {
  name: string;
  displayName: string;
  isToolUse: boolean;
  isMultipleOutput: boolean;
  whitelistApproved: boolean;
}

export interface ProxyEntitlement {
  enabled: boolean;
  sessionToken?: string;
  sessionId?: string;
  baseUrl?: string;
  expiresAt?: string;
}

export interface SupabaseEntitlements {
  remoteAgents: RemoteAgentDescriptor[];
  proxy: ProxyEntitlement;
  quota?: {
    remainingUsd?: number;
    totalUsd?: number;
  };
}

const ENTITLEMENTS_FUNCTION =
  process.env.SUPABASE_ENTITLEMENTS_FUNCTION ?? 'auth-get-capabilities';

let supabaseClient: SupabaseClient | undefined;
let cachedSession: StoredSupabaseSession | undefined;
let cachedProxySession: StoredProxySession | undefined;
let cachedEntitlements: SupabaseEntitlements | undefined;

const entitlementEmitter = new vscode.EventEmitter<
  SupabaseEntitlements | undefined
>();

export const onEntitlementsChanged = entitlementEmitter.event;

function readSupabaseConfig(): { url: string; anonKey: string } | undefined {
  const configUrl = getConfig<string>('auth.supabaseUrl', '').trim();
  const configAnonKey = getConfig<string>('auth.supabaseAnonKey', '').trim();
  const url = configUrl || process.env.SUPABASE_URL || '';
  const anonKey = configAnonKey || process.env.SUPABASE_ANON_KEY || '';

  if (!url || !anonKey) {
    logger.debug(
      CHANNEL,
      'Supabase configuration missing. Skipping client creation.',
    );
    return undefined;
  }

  return { url, anonKey };
}

export async function ensureSupabaseClient(): Promise<
  SupabaseClient | undefined
> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const config = readSupabaseConfig();
  if (!config) {
    return undefined;
  }

  supabaseClient = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      detectSessionInUrl: false,
      autoRefreshToken: false,
    },
  });

  logger.info(CHANNEL, 'Supabase client initialised');
  return supabaseClient;
}

function setCachedEntitlements(
  entitlements: SupabaseEntitlements | undefined,
): void {
  cachedEntitlements = entitlements;
  entitlementEmitter.fire(entitlements);
}

export function getEntitlements(): SupabaseEntitlements | undefined {
  return cachedEntitlements;
}

export function getProxySession(): StoredProxySession | undefined {
  return cachedProxySession;
}

export function getCurrentSession(): StoredSupabaseSession | undefined {
  return cachedSession;
}

async function updateProxySession(proxy: ProxyEntitlement): Promise<void> {
  if (!proxy.enabled || !proxy.sessionToken) {
    cachedProxySession = undefined;
    await saveProxySession(undefined);
    return;
  }

  cachedProxySession = {
    token: proxy.sessionToken,
    expiresAt: proxy.expiresAt,
    sessionId: proxy.sessionId,
  };
  await saveProxySession(cachedProxySession);

  const expiresAtText = proxy.expiresAt
    ? new Date(proxy.expiresAt).toLocaleString()
    : '';

  await updateConfig('auth.proxySessionExpiresAt', expiresAtText, {
    prefix: true,
  });
}

async function fetchEntitlements(
  session: StoredSupabaseSession,
): Promise<SupabaseEntitlements | undefined> {
  const client = await ensureSupabaseClient();
  if (!client) {
    return undefined;
  }

  try {
    const { data, error } = await client.functions.invoke(
      ENTITLEMENTS_FUNCTION,
      {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
        },
      },
    );

    if (error) {
      logger.error(
        CHANNEL,
        `Failed to load Supabase entitlements: ${error.message}`,
      );
      return undefined;
    }

    const remoteAgents: RemoteAgentDescriptor[] = Array.isArray(
      (data as any)?.remoteAgents,
    )
      ? ((data as any).remoteAgents as any[]).map((entry) => ({
          name: String(entry.name ?? entry.id ?? ''),
          displayName: String(
            entry.displayName ?? entry.label ?? entry.name ?? '',
          ),
          isToolUse: Boolean(entry.isToolUse ?? entry.agentType === 'toolUse'),
          isMultipleOutput: Boolean(entry.isMultiple ?? entry.isMultipleOutput),
          whitelistApproved: entry.whitelistApproved !== false,
        }))
      : [];

    const proxyPayload = (data as any)?.proxy ?? {};
    const proxy: ProxyEntitlement = {
      enabled: Boolean(proxyPayload.enabled ?? proxyPayload.sessionToken),
      sessionToken: proxyPayload.sessionToken
        ? String(proxyPayload.sessionToken)
        : undefined,
      sessionId: proxyPayload.sessionId
        ? String(proxyPayload.sessionId)
        : undefined,
      baseUrl: proxyPayload.baseUrl ? String(proxyPayload.baseUrl) : undefined,
      expiresAt: proxyPayload.expiresAt
        ? String(proxyPayload.expiresAt)
        : undefined,
    };

    const quotaPayload = (data as any)?.quota ?? {};

    const entitlements: SupabaseEntitlements = {
      remoteAgents: remoteAgents.filter((agent) => agent.whitelistApproved),
      proxy,
      quota: {
        remainingUsd: quotaPayload.remainingUsd,
        totalUsd: quotaPayload.totalUsd,
      },
    };

    return entitlements;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Unexpected error while fetching entitlements: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

export async function applySupabaseSession(
  session: StoredSupabaseSession | undefined,
): Promise<SupabaseEntitlements | undefined> {
  cachedSession = session;
  await saveSupabaseSession(session);

  if (!session) {
    await updateProxySession({ enabled: false });
    setCachedEntitlements(undefined);
    await clearSupabaseSession();
    return undefined;
  }

  const entitlements = await fetchEntitlements(session);
  setCachedEntitlements(entitlements);

  if (entitlements) {
    await updateProxySession(entitlements.proxy);
  } else {
    await updateProxySession({ enabled: false });
  }

  return entitlements ?? undefined;
}

export async function restoreSupabaseState(): Promise<
  SupabaseEntitlements | undefined
> {
  const storedSession = await loadSupabaseSession();
  if (!storedSession) {
    logger.debug(CHANNEL, 'No persisted Supabase session found.');
    cachedSession = undefined;
    cachedProxySession = await loadProxySession();
    return undefined;
  }

  cachedSession = storedSession;
  cachedProxySession = await loadProxySession();
  return applySupabaseSession(storedSession);
}

export async function refreshEntitlements(): Promise<
  SupabaseEntitlements | undefined
> {
  if (!cachedSession) {
    return undefined;
  }

  const entitlements = await fetchEntitlements(cachedSession);
  setCachedEntitlements(entitlements);

  if (entitlements) {
    await updateProxySession(entitlements.proxy);
  }

  return entitlements;
}

export async function clearSupabaseState(): Promise<void> {
  cachedSession = undefined;
  cachedProxySession = undefined;
  setCachedEntitlements(undefined);
  await clearSupabaseSession();
  await updateProxySession({ enabled: false });
}
