import { Effect } from 'effect';
import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import { ensureError } from '@utils/errors/errorMessage';

type SettingsRemoteAgentPromptResult =
  | { ok: true; config: string }
  | {
      ok: false;
      message: string;
    };

export const getRemoteAgentPromptConfig = Effect.fn(
  'SettingsRemoteAgentPromptController.getRemoteAgentPromptConfig',
)(function* (
  agentName: string,
): Effect.fn.Return<SettingsRemoteAgentPromptResult, Error, SupabaseAuth> {
  const auth = yield* SupabaseAuth;
  const token = yield* auth.accessToken;
  if (!token) {
    return {
      ok: false,
      message: 'Authentication required. Sign in using "TeXRA: Sign In".',
    };
  }

  return {
    ok: true,
    config: yield* Effect.tryPromise({
      try: () => fetchRemoteAgentConfigYaml(agentName, token),
      catch: ensureError,
    }),
  };
});
