import { Effect } from 'effect';

import { loadCliDetailedAccountStatusLines } from '@cli/runtime/apiStatus';
import { bumpCodexPreferenceVersion } from '@cli/chat/tui/state/cliState';
import { saveProviderApiKey } from '@cli/runtime/providerApiKey';
import {
  parseCliModelAccessSelection,
  type CliModelAccessSelection,
} from '@cli/runtime/modelAccessRoute';
import { updateCliModelAccess } from '@cli/runtime/modelAccessSelection';

import type { ApiProvider } from '@model/apiProviders';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { codingPlanForApiProvider } from '@shared/codingPlanSubscriptions';
import { collapseWhitespace } from '@utils/text/stringUtils';
import {
  abortableSlashCommand,
  type SlashCommandOutput,
  type SlashCommandContext,
  transcriptSlashCommandOutput,
} from './slashContext';

const MODEL_ACCESS_USAGE =
  'Usage: /api chatgpt | grok | kimi-code | glm-code | status';

/**
 * Save a provider key and refresh access-dependent TUI views. Returns only the
 * extra notice a provider needs, if any — the caller owns the
 * "Saved the <provider> API key." confirmation line.
 */
export const applyCliProviderApiKey = Effect.fn('applyCliProviderApiKey')(
  function* (secrets: PlatformSecrets, provider: ApiProvider, key: string) {
    yield* saveProviderApiKey(secrets, provider, key);
    bumpCodexPreferenceVersion();
    const codingPlan = codingPlanForApiProvider(provider);
    if (!codingPlan) return undefined;
    if (!codingPlan.exclusiveCredential) {
      return `Tip: ${codingPlan.retryFallbackName} is the default; enable '${codingPlan.preferenceLabel}' with \`/api ${codingPlan.cliProvider}\` or in \`/config\` to use ${codingPlan.displayName}.`;
    }
    // The coding-only models route through the subscription automatically;
    // dual-backend K3 needs the opt-in switch, which is only discoverable if
    // we name it here.
    return "Tip: the Kimi for Coding models use your subscription automatically; to use it for Kimi K3 too, enable 'Prefer Kimi Code' in /config.";
  },
);

async function applyCliModelAccessSelectionWithSignal(
  stores: SettingsStores,
  runtime: ProcessRuntime,
  selection: CliModelAccessSelection,
  context: SlashCommandContext | undefined,
  output: SlashCommandOutput,
  signal: AbortSignal,
): Promise<void> {
  const access = await runtime.runPromise(
    updateCliModelAccess(stores, context?.cliContext, selection, {
      writeProgress: (message) =>
        output.writeProgress(message, { copyable: true }),
    }),
    { signal },
  );
  bumpCodexPreferenceVersion();
  output.appendOutcome(collapseWhitespace(access.message));
}

export function applyCliModelAccessSelection(
  stores: SettingsStores,
  runtime: ProcessRuntime,
  selection: CliModelAccessSelection,
  context: SlashCommandContext | undefined,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
): Promise<void> & { readonly abort: () => void } {
  return abortableSlashCommand((signal) =>
    applyCliModelAccessSelectionWithSignal(
      stores,
      runtime,
      selection,
      context,
      output,
      signal,
    ),
  );
}

export function applyCliModelAccessInput(
  stores: SettingsStores,
  runtime: ProcessRuntime,
  routeInput: string,
  context: SlashCommandContext,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
): Promise<void> & { readonly abort: () => void } {
  return abortableSlashCommand(async (signal) => {
    const normalized = routeInput.trim().toLowerCase();

    if (!normalized || normalized === 'status') {
      const lines = await runtime.runPromise(
        loadCliDetailedAccountStatusLines(context.stores, context.secrets),
      );
      output.appendOutcome(lines.join('\n'));
      return;
    }

    const selection = parseCliModelAccessSelection(normalized);
    if (!selection) {
      output.setNotice(MODEL_ACCESS_USAGE);
      return;
    }

    await applyCliModelAccessSelectionWithSignal(
      stores,
      runtime,
      selection,
      context,
      output,
      signal,
    );
  });
}

export async function showCliAuthStatus(
  stores: SettingsStores,
  runtime: ProcessRuntime,
  secrets: PlatformSecrets,
): Promise<void> {
  const lines = await runtime.runPromise(
    loadCliDetailedAccountStatusLines(stores, secrets),
  );
  transcriptSlashCommandOutput.appendOutcome(lines.join('\n'));
}
