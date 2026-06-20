// Local imports - auth
import { ULTRA_TIER, type UserTier } from '@auth/config';

export type SettingsRemoteAgentPromptResult =
  | { ok: true; config: string }
  | {
      ok: false;
      message: string;
    };

export interface SettingsRemoteAgentPromptControllerDeps {
  getUserTier(): Promise<UserTier>;
  getAccessToken(): Promise<string | null>;
  fetchPromptConfig(agentName: string, accessToken: string): Promise<string>;
}

export class SettingsRemoteAgentPromptController {
  constructor(private readonly deps: SettingsRemoteAgentPromptControllerDeps) {}

  async getPromptConfig(
    agentName: string,
  ): Promise<SettingsRemoteAgentPromptResult> {
    const tier = await this.deps.getUserTier();
    if (tier !== ULTRA_TIER) {
      return {
        ok: false,
        message: 'Viewing remote agent prompts requires an Ultra plan.',
      };
    }

    const token = await this.deps.getAccessToken();
    if (!token) {
      return {
        ok: false,
        message: 'Authentication required. Sign in using "TeXRA: Sign In".',
      };
    }

    return {
      ok: true,
      config: await this.deps.fetchPromptConfig(agentName, token),
    };
  }
}
