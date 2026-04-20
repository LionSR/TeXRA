// Third-party imports
import { z } from 'zod';

// Local imports
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
  description: `Remove a provider's API key from SecretStorage. Use when the user wants to rotate or clear credentials. Non-destructive of any other state — just deletes that one secret.`,
  schema: UnsetApiKeyInputSchema,
}) {
  protected async execute(input: UnsetApiKeyInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const provider = input.provider.trim();

    if (!platform.secrets.providers.includes(provider)) {
      throw new ToolError(
        `Unknown provider "${provider}". Supported: ${platform.secrets.providers.join(', ')}.`,
      );
    }

    if (!(await platform.secrets.apiKeyExists(provider))) {
      return {
        summary: `No stored ${provider} API key`,
        output: `There was no stored API key for provider "${provider}" to remove.`,
      };
    }

    await platform.secrets.deleteApiKey(provider);
    await platform.commands
      .invoke('texra.refreshApiKeyStatus')
      .catch(() => undefined);

    return {
      summary: `Removed ${provider} API key`,
      output: `Removed stored API key for provider "${provider}".`,
    };
  }
}
