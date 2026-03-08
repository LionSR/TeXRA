/**
 * Platform-agnostic interfaces for API key management and server-side key access.
 *
 * These interfaces abstract away VS Code dependencies so that model handlers
 * (in the VS Code-free src/agent/ zone) can retrieve API keys and check
 * server-side key status without importing @frontend/ or @auth/ modules.
 *
 * Implementations are injected at activation time via setKeyServices().
 */

/** Subset of ServerSideKeyService methods used by model handlers. */
export interface IServerSideKeyService {
  shouldUseServerSideKeysSync(provider: string, modelName?: string): boolean;
  getUseIncludedModelAccess(): boolean;
  canUseServerSideKeys(): Promise<boolean>;
  getUserTier(): unknown;
  getRelayBaseUrl(provider: string): string;
  isProviderOnServer(provider: string): boolean;
  canUseModelSync(modelName: string): boolean;
}

/** Subset of SecretManager used by model handlers and model options. */
export interface ISecretManager {
  getApiKey(provider: string): Promise<string>;
  apiKeyExists(provider: string): Promise<boolean>;
  readonly API_PROVIDERS: readonly string[];
}

/** Subset of SupabaseClient used by model handlers (access token retrieval). */
export interface IAuthClient {
  getAccessToken(forceRefresh?: boolean): Promise<string | null>;
  isTokenExpiringSoon(): boolean;
}

// ---------------------------------------------------------------------------
// Injectable singletons
// ---------------------------------------------------------------------------

let _serverSideKeyService: IServerSideKeyService | null = null;
let _secretManager: ISecretManager | null = null;
let _authClient: IAuthClient | null = null;

/**
 * Register platform-specific key service implementations.
 * Called once from extension.ts during activation.
 */
export function setKeyServices(services: {
  serverSideKeyService: IServerSideKeyService;
  secretManager: ISecretManager;
  authClient: IAuthClient;
}): void {
  _serverSideKeyService = services.serverSideKeyService;
  _secretManager = services.secretManager;
  _authClient = services.authClient;
}

/** Get the registered server-side key service. */
export function getKeyService(): IServerSideKeyService {
  if (!_serverSideKeyService) {
    throw new Error(
      'Server-side key service not initialized. Call setKeyServices() first.',
    );
  }
  return _serverSideKeyService;
}

/** Get the registered secret manager. */
export function getSecretService(): ISecretManager {
  if (!_secretManager) {
    throw new Error(
      'Secret manager not initialized. Call setKeyServices() first.',
    );
  }
  return _secretManager;
}

/** Get the registered auth client. */
export function getAuthClient(): IAuthClient {
  if (!_authClient) {
    throw new Error(
      'Auth client not initialized. Call setKeyServices() first.',
    );
  }
  return _authClient;
}
