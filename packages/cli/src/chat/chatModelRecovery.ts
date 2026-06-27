import { type CliNoAvailableModelsRecoveryOptions } from '@cli/runtime/modelAccess';

export const CHAT_API_MODE_MODEL_RECOVERY = {
  includedModeAction: 'switch to included relay with `/api included`',
  loginAction: 'run `/login`',
  personalModeAction: 'switch to personal API keys with `/api personal`',
  configureKeyAction: 'configure a provider API key',
} satisfies CliNoAvailableModelsRecoveryOptions;
