type SettingsRemoteAgentPromptResult =
  | { ok: true; config: string }
  | {
      ok: false;
      message: string;
    };

interface SettingsRemoteAgentPromptControllerDeps {
  getAccessToken(): Promise<string | null>;
  fetchPromptConfig(agentName: string, accessToken: string): Promise<string>;
}

export class SettingsRemoteAgentPromptController {
  constructor(private readonly deps: SettingsRemoteAgentPromptControllerDeps) {}

  async getPromptConfig(
    agentName: string,
  ): Promise<SettingsRemoteAgentPromptResult> {
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
