import * as vscode from 'vscode';

let secretStorage: vscode.SecretStorage | undefined;

export function initializeSecrets(context: vscode.ExtensionContext) {
  secretStorage = context.secrets;
}

export async function getSecret(key: string): Promise<string | undefined> {
  if (!secretStorage) {
    throw new Error('Secret storage not initialized');
  }
  return await secretStorage.get(key);
}

export async function setSecret(key: string, value: string): Promise<void> {
  if (!secretStorage) {
    throw new Error('Secret storage not initialized');
  }
  await secretStorage.store(key, value);
}

export async function deleteSecret(key: string): Promise<void> {
  if (!secretStorage) {
    throw new Error('Secret storage not initialized');
  }
  await secretStorage.delete(key);
}

// List of supported API providers
export const API_PROVIDERS = [
  'openai',
  'anthropic',
  'openRouter',
  'google',
  'xai',
  'deepseek',
] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];

// Helper function to get API key secret name
export function getApiKeySecretName(provider: ApiProvider): string {
  return `apiKey.${provider}`;
}

/**
 * Get API key from secret storage or environment variable
 * @param provider The API provider to get the key for
 * @returns The API key if found
 * @throws Error if no API key is found
 */
export async function getApiKey(provider: ApiProvider): Promise<string> {
  // Try secret storage first
  const secretKey = await getSecret(getApiKeySecretName(provider));
  if (secretKey) {
    return secretKey;
  }

  // Fall back to environment variable
  const envKey = `${provider.toUpperCase()}_API_KEY`;
  const envValue = process.env[envKey];
  if (!envValue) {
    throw new Error(
      `No API key found for ${provider}. Please set it using the "Set API Key" command or ${envKey} environment variable.`,
    );
  }

  return envValue;
}
