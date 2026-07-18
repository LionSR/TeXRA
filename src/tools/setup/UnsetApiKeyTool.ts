// Third-party imports
import { z } from 'zod';

// Local imports
import { apiKeyEnvName } from '@model/apiProviders';
import { type ToolResult } from '@shared/schemas/toolResult';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform, setupSecrets } from './platform';
import { refreshApiKeyCaches, requireApiProvider } from './apiKeyHelpers';

const UnsetApiKeyInputSchema = z.strictObject({
  provider: z
    .string()
    .min(1)
    .describe('Provider name to remove the stored key for.'),
});

type UnsetApiKeyInput = z.infer<typeof UnsetApiKeyInputSchema>;

export class UnsetApiKeyTool extends defineTool({
  name: 'unset_api_key',
  requiresApproval: true,
  description: `Remove a provider's API key from TeXRA's persisted credential store. Use when the user wants to rotate or clear credentials. Non-destructive of any other state — just deletes that one secret. If the key is actually coming from a \`<PROVIDER>_API_KEY\` environment variable, this tool will report that — the credential store has nothing to remove, and the env var must be cleared in the user's shell.`,
  schema: UnsetApiKeyInputSchema,
}) {
  protected async execute(input: UnsetApiKeyInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const provider = requireApiProvider(input.provider);
    const envVar = apiKeyEnvName(provider);

    const storedExists = await setupSecrets.storedApiKeyExists(provider);
    if (!storedExists) {
      // If no persisted entry exists but a *usable* (non-blank) key
      // is still reported, it's coming from the `<PROVIDER>_API_KEY`
      // env var — `deleteApiKey` can't touch that, so be explicit.
      // Use `hasUsableApiKey` (not `apiKeyExists`) so a stale
      // `PROVIDER_API_KEY=""` doesn't falsely claim an env var is
      // supplying credentials.
      const envExists = await setupSecrets.hasUsableApiKey(provider);
      if (envExists) {
        return {
          status: 'executed',
          summary: `${provider} key is env-var-backed`,
          output: `No stored API key for "${provider}" to remove, but one is still active via the ${envVar} environment variable. The credential store has nothing to clear — unset ${envVar} in your shell (or the source that sets it) to remove this credential.`,
        };
      }
      return {
        status: 'executed',
        summary: `No stored ${provider} API key`,
        output: `There was no stored API key for provider "${provider}" to remove.`,
      };
    }

    await setupSecrets.deleteApiKey(provider);
    // Mirror the manual removal flow: drop cached model availability and
    // key-origin lookups so models that just lost their credential stop
    // appearing selectable.
    await refreshApiKeyCaches(platform);

    // A shell env var can shadow the deletion — flag that so the agent can
    // tell the user why the key still appears to exist after removal.
    // `hasUsableApiKey` here too, so a blank env var doesn't trip the
    // "env var still active" branch.
    const stillPresent = await setupSecrets.hasUsableApiKey(provider);
    if (stillPresent) {
      return {
        status: 'executed',
        summary: `Removed stored ${provider} key (env var still active)`,
        output: `Removed stored API key for provider "${provider}", but the ${envVar} environment variable is still set and will continue to provide a credential. Unset ${envVar} in your shell to fully remove it.`,
      };
    }

    return {
      status: 'executed',
      summary: `Removed ${provider} API key`,
      output: `Removed stored API key for provider "${provider}".`,
    };
  }
}
