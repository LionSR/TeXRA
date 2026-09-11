import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { SupabaseClient } from '@auth/SupabaseClient';

type SettingsRemoteAgentPromptResult =
  | { ok: true; config: string }
  | {
      ok: false;
      message: string;
    };

export async function getRemoteAgentPromptConfig(
  agentName: string,
): Promise<SettingsRemoteAgentPromptResult> {
  const token = await SupabaseClient.getAccessToken();
  if (!token) {
    return {
      ok: false,
      message: 'Authentication required. Sign in using "TeXRA: Sign In".',
    };
  }

  return {
    ok: true,
    config: await fetchRemoteAgentConfigYaml(agentName, token),
  };
}
