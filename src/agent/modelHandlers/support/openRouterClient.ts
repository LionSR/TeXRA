// Third-party imports
import type { OpenRouter } from '@openrouter/sdk';

// Local imports - agent
import { SecretManager } from '@frontend/secretManager';

/** Type alias representing an initialized OpenRouter SDK client. */
export type OpenRouterClient = InstanceType<typeof OpenRouter>;

interface ClientOptions {
  serverURL?: string | null;
  timeoutMs?: number;
  userAgent?: string;
  debugLogger?: (message: string, ...args: unknown[]) => void;
}

/**
 * Lazily imports the OpenRouter SDK and constructs a client with the stored API key.
 */
export async function createOpenRouterClient(
  options: ClientOptions = {},
): Promise<OpenRouterClient> {
  let apiKey: string;
  try {
    apiKey = await SecretManager.getApiKey('openRouter');
  } catch (err) {
    throw new Error(
      'Missing API key for OpenRouter. Please set it using the "Set API Key" command.',
    );
  }

  const module = await import('@openrouter/sdk');
  const { OpenRouter } = module;

  const debugLogger = options.debugLogger
    ? {
        log: options.debugLogger,
        group: () => {},
        groupEnd: () => {},
      }
    : undefined;

  return new OpenRouter({
    apiKey,
    serverURL: options.serverURL ?? undefined,
    timeoutMs: options.timeoutMs,
    userAgent: options.userAgent,
    debugLogger,
  });
}
