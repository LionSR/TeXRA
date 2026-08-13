import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

const CHANNEL = 'progressViewCommands';

function getProgressProviderOrWarn(): ProgressViewProvider | undefined {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) {
    void showLoggedMessage(
      CHANNEL,
      'Progress View is not available. Please try again.',
    );
  }
  return provider;
}

/**
 * Show the progress view. The `inPlace` flag controls whether to keep the
 * sidebar in its current location vs. focusing it.
 */
export async function showProgressView(inPlace: boolean): Promise<void> {
  await getProgressProviderOrWarn()?.showProgressView({ inPlace });
}

export async function openProgressViewInTab(): Promise<void> {
  await getProgressProviderOrWarn()?.popOutToEditor();
}
