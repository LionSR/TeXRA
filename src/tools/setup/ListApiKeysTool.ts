// Third-party imports
import { z } from 'zod';

// Local imports
import { API_PROVIDERS, apiKeySecretName } from '@model/apiProviders';
import { type ToolResult } from '@shared/schemas/toolResult';
import { GITHUB_TOKEN_STORAGE_KEY } from '@tools/github/githubAuth';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

const ListApiKeysInputSchema = z
  .strictObject({})
  .describe(
    'No inputs — returns all secret key names stored in TeXRA SecretStorage.',
  );

type ListApiKeysInput = z.infer<typeof ListApiKeysInputSchema>;

const KNOWN_PROVIDER_KEY_MAP = new Map(
  API_PROVIDERS.map((p) => [apiKeySecretName(p), p] as const),
);

/**
 * List all secret key *names* in SecretStorage (values are never read).
 *
 * Uses `SecretStorage.keys()` (stable since VS Code 1.105). The result
 * is categorised: known provider keys, GitHub token, and any other entries
 * stored by TeXRA (auth sessions, etc.) or left over from previous installs.
 */
export class ListApiKeysTool extends defineTool({
  name: 'list_api_keys',
  description: `Return all secret key names currently stored in TeXRA's SecretStorage (values are never read or surfaced). Use this to audit which API keys and tokens are present, detect stale or unexpected entries, and plan set_api_key / unset_api_key calls. Prefer probe_environment for a fuller overview that also covers tool installations and auth status.`,
  schema: ListApiKeysInputSchema,
}) {
  protected async execute(_input: ListApiKeysInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const storedKeys = await platform.secrets.listStoredKeys();

    if (storedKeys.length === 0) {
      return {
        summary: 'No secrets stored',
        output: 'SecretStorage is empty — no API keys or tokens are stored.',
      };
    }

    const providerKeys: string[] = [];
    const unknownApiKeys: string[] = [];
    let hasGithubToken = false;
    const otherKeys: string[] = [];

    for (const key of storedKeys) {
      const provider = KNOWN_PROVIDER_KEY_MAP.get(key);
      if (provider !== undefined) {
        providerKeys.push(provider);
      } else if (key === GITHUB_TOKEN_STORAGE_KEY) {
        hasGithubToken = true;
      } else if (key.startsWith('apiKey.')) {
        unknownApiKeys.push(key);
      } else {
        otherKeys.push(key);
      }
    }

    const missingProviders = API_PROVIDERS.filter(
      (p) => !providerKeys.includes(p),
    );

    const lines: string[] = [`Stored secrets (${storedKeys.length} total):`];

    if (providerKeys.length > 0) {
      lines.push('', 'Provider API keys stored:');
      for (const p of providerKeys) lines.push(`  ${p}`);
      if (missingProviders.length > 0) {
        lines.push('', 'Providers without a stored key:');
        for (const p of missingProviders) lines.push(`  ${p}`);
      }
    } else {
      lines.push('', 'No provider API keys stored.');
    }

    if (unknownApiKeys.length > 0) {
      lines.push('', 'Unrecognised apiKey.* entries (stale?):');
      for (const k of unknownApiKeys) lines.push(`  ${k}`);
    }

    if (hasGithubToken) {
      lines.push('', 'GitHub token: stored');
    }

    if (otherKeys.length > 0) {
      lines.push('', 'Other stored secrets:');
      for (const k of otherKeys) lines.push(`  ${k}`);
    }

    const providerSummary =
      providerKeys.length === 0
        ? 'no provider keys'
        : `${providerKeys.length}/${API_PROVIDERS.length} provider keys`;

    return {
      summary: `${storedKeys.length} stored secret${storedKeys.length === 1 ? '' : 's'}: ${providerSummary}`,
      output: lines.join('\n'),
    };
  }
}
