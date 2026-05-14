// Third-party imports
import { z } from 'zod';

// Local imports
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  API_PROVIDERS,
  invalidateApiKeyCache,
  isApiProvider,
} from '@model/apiProviders';
import { ToolError, type ToolResult } from '@tools/result';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

const UnsetApiKeyInputSchema = z.strictObject({
  provider: z
    .string()
    .min(1)
    .describe('Provider name to remove the stored key for.'),
});

type UnsetApiKeyInput = z.infer<typeof UnsetApiKeyInputSchema>;

export class UnsetApiKeyTool extends defineTool({
  name: 'unset_api_key',
  description: `Remove a provider's API key from SecretStorage. Use when the user wants to rotate or clear credentials. Non-destructive of any other state — just deletes that one secret. If the key is actually coming from a \`<PROVIDER>_API_KEY\` environment variable, this tool will report that — SecretStorage has nothing to remove, and the env var must be cleared in the user's shell.`,
  schema: UnsetApiKeyInputSchema,
}) {
  protected async execute(input: UnsetApiKeyInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const provider = input.provider.trim();

    if (!isApiProvider(provider)) {
      throw new ToolError(
        `Unknown provider "${provider}". Supported: ${API_PROVIDERS.join(', ')}.`,
      );
    }

    const storedExists = await platform.secrets.storedApiKeyExists(provider);
    if (!storedExists) {
      // If no SecretStorage entry exists but a *usable* (non-blank) key
      // is still reported, it's coming from the `<PROVIDER>_API_KEY`
      // env var — `deleteApiKey` can't touch that, so be explicit.
      // Use `hasUsableApiKey` (not `apiKeyExists`) so a stale
      // `PROVIDER_API_KEY=""` doesn't falsely claim an env var is
      // supplying credentials.
      const envExists = await platform.secrets.hasUsableApiKey(provider);
      if (envExists) {
        const envVar = `${provider.toUpperCase()}_API_KEY`;
        return {
          summary: `${provider} key is env-var-backed`,
          output: `No stored API key for "${provider}" to remove, but one is still active via the ${envVar} environment variable. SecretStorage has nothing to clear — unset ${envVar} in your shell (or the source that sets it) to remove this credential.`,
        };
      }
      return {
        summary: `No stored ${provider} API key`,
        output: `There was no stored API key for provider "${provider}" to remove.`,
      };
    }

    await platform.secrets.deleteApiKey(provider);
    // Mirror the manual removal flow: drop cached model availability and
    // key-origin lookups so models that just lost their credential stop
    // appearing selectable.
    invalidateModelOptionsCache();
    invalidateApiKeyCache();
    await Promise.all([
      platform.commands
        .invoke('texra.refreshApiKeyStatus')
        .catch(() => undefined),
      platform.commands
        .invoke('texra.refreshAllOptions')
        .catch(() => undefined),
    ]);

    // A shell env var can shadow the deletion — flag that so the agent can
    // tell the user why the key still appears to exist after removal.
    // `hasUsableApiKey` here too, so a blank env var doesn't trip the
    // "env var still active" branch.
    const stillPresent = await platform.secrets.hasUsableApiKey(provider);
    if (stillPresent) {
      const envVar = `${provider.toUpperCase()}_API_KEY`;
      return {
        summary: `Removed stored ${provider} key (env var still active)`,
        output: `Removed stored API key for provider "${provider}", but the ${envVar} environment variable is still set and will continue to provide a credential. Unset ${envVar} in your shell to fully remove it.`,
      };
    }

    return {
      summary: `Removed ${provider} API key`,
      output: `Removed stored API key for provider "${provider}".`,
    };
  }
}
