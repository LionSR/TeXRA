// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { settleQuickInput } from '@commands/_shared/quickInputUtils';
import { SecretManager, ApiProvider } from '@frontend/secretManager';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { invalidateApiKeyCache } from '@model/apiProviders';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { PROVIDER_URLS } from '@shared/constants/providers';

const CHANNEL = 'ApiKeyCommands';
logger.initialize(CHANNEL);

export const apiKeyCommands = {
  setApiKey: 'texra.setApiKey',
  removeApiKey: 'texra.removeApiKey',
};

async function refreshApiKeyUI(): Promise<void> {
  invalidateModelOptionsCache();
  invalidateApiKeyCache();
  await vscode.commands.executeCommand('texra.refreshApiKeyStatus');
  await vscode.commands.executeCommand('texra.refreshAllOptions');
}

async function setApiKeyForProvider(
  provider: ApiProvider,
  showNavigationFallback = false,
): Promise<void> {
  const apiKey = await promptForApiKey(provider, showNavigationFallback);

  if (!apiKey) {
    return;
  }

  try {
    await SecretManager.set(
      SecretManager.getApiKeySecretName(provider),
      apiKey,
    );
    vscode.window.showInformationMessage(`${provider} API key has been set`);
    await refreshApiKeyUI();
    const view = await getMainWebview();
    view?.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER,
    });
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      `Failed to set ${provider} API key`,
      err,
    );
  }
}

/**
 * Prompt for an API key. When the host exposes InputBox title buttons, add a
 * "Get API Key" action that opens the provider's key portal without closing the
 * input box, so the user can paste straight away. Older hosts use the previous
 * message-button fallback when the provider-picker path asks for it.
 */
async function promptForApiKey(
  provider: ApiProvider,
  showNavigationFallback: boolean,
): Promise<string | undefined> {
  const ib = vscode.window.createInputBox();
  const supportsTitleButtons = Reflect.has(ib, 'buttons');

  if (!supportsTitleButtons && showNavigationFallback) {
    const actions: Array<vscode.MessageItem & { id: 'enter' | 'getApiKey' }> = [
      { title: 'Enter Key', id: 'enter' },
      { title: 'Get API Key', id: 'getApiKey' },
    ];
    const action = await vscode.window.showInformationMessage(
      `Set your ${provider} API key`,
      ...actions,
    );

    if (action == null) {
      ib.dispose();
      return undefined;
    }

    if (action.id === 'getApiKey') {
      ib.dispose();
      await vscode.env.openExternal(vscode.Uri.parse(PROVIDER_URLS[provider]));
      return undefined;
    }
  }

  ib.title = `Set ${provider} API key`;
  ib.prompt = `Enter ${provider} API key`;
  ib.password = true;
  ib.placeholder = '************************************';
  const getKeyButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('link-external'),
    tooltip: `Get ${provider} API key`,
  };
  if (supportsTitleButtons) {
    ib.buttons = [getKeyButton];
    ib.onDidTriggerButton((button) => {
      if (button === getKeyButton) {
        void vscode.env.openExternal(vscode.Uri.parse(PROVIDER_URLS[provider]));
      }
    });
  }
  return settleQuickInput(ib, (accept) => {
    ib.onDidAccept(() => {
      accept(ib.value);
    });
  });
}

/**
 * Set an API key. Migrated to the shared command registry in
 * #3781 batch 4. The registry forwards a single typed argument so the
 * optional `provider` is parsed at the dispatch boundary.
 */
export async function setApiKey(provider?: ApiProvider): Promise<void> {
  if (provider) {
    await setApiKeyForProvider(provider);
    return;
  }

  const providerItems = await SecretManager.getApiProviderQuickPickItems();
  const providerPick = await pickProvider(
    providerItems,
    'Select API provider',
    "Keys are stored in VS Code's encrypted secret store, never on disk.",
  );

  if (providerPick?.provider) {
    await setApiKeyForProvider(providerPick.provider, true);
  }
}

type ProviderQuickPickItem = Awaited<
  ReturnType<typeof SecretManager.getApiProviderQuickPickItems>
>[number];

/** Shared provider picker with a persistent prompt hint (VS Code 1.108+). */
async function pickProvider(
  items: ProviderQuickPickItem[],
  placeholder: string,
  promptHint: string,
): Promise<ProviderQuickPickItem | undefined> {
  const qp = vscode.window.createQuickPick<ProviderQuickPickItem>();
  qp.placeholder = placeholder;
  qp.items = items;
  const defaultItem = items[0];
  if (defaultItem) {
    qp.activeItems = [defaultItem];
  }
  if ('prompt' in qp) {
    (
      qp as vscode.QuickPick<ProviderQuickPickItem> & { prompt: string }
    ).prompt = promptHint;
  }
  return settleQuickInput(qp, (accept) => {
    qp.onDidAccept(() => {
      accept(qp.activeItems[0] ?? qp.selectedItems[0]);
    });
  });
}

/**
 * Remove an API key after a confirmation prompt. Migrated to the shared
 * command registry in #3781 batch 4.
 */
export async function removeApiKey(): Promise<void> {
  const providerItems = await SecretManager.getApiProviderQuickPickItems();
  const providerPick = await pickProvider(
    providerItems,
    'Select API provider to remove key',
    'Only removes the key from TeXRA — does not delete it from the provider.',
  );

  const provider = providerPick?.provider;
  if (!provider) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove the ${provider} API key? This cannot be undone.`,
    'Remove',
    'Cancel',
  );
  if (confirm !== 'Remove') {
    return;
  }

  try {
    await SecretManager.delete(SecretManager.getApiKeySecretName(provider));
    vscode.window.showInformationMessage(
      `${provider} API key has been removed`,
    );
    await refreshApiKeyUI();
    const view = await getMainWebview();
    view?.webview.postMessage({
      command: (await SecretManager.anyApiKeyExists())
        ? MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER
        : MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER,
    });
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      `Failed to remove ${provider} API key`,
      err,
    );
  }
}

/**
 * Both `texra.setApiKey` and `texra.removeApiKey` are now registered through
 * the shared command registry in `extensionCommandSurface.ts`. The
 * registration function is kept as a no-op so existing call sites in
 * `commands.ts` don't have to be reshuffled — removing the dependency would
 * require dropping it from the `registerCommands` call list, which is
 * outside the scope of this batch.
 */
export function registerApiKeyCommands(
  _context: vscode.ExtensionContext,
): void {
  // Intentionally empty: handlers moved to the shared registry (#3781 batch 4).
}
