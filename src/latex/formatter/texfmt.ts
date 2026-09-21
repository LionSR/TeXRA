// Third-party imports
import { Effect } from 'effect';

// Local imports - log
import { withLogChannel } from '@logger/effectLog';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';

export const TEXFMT_CONFIG_KEY = 'texra.latex.texfmtConfig';

export const runTexFmt = Effect.fn('latex.runTexFmt')(
  function* (
    filePath: string,
    workspaceRoot: string | undefined,
    texfmtConfig: string,
    settings: SettingsStores,
  ) {
    const args = [
      ...(texfmtConfig ? ['--config', texfmtConfig] : ['--nowrap']),
      filePath,
    ];

    const result = yield* runToolWithCheck('tex-fmt', args, {
      channel: CHANNEL,
      cwd: workspaceRoot,
      // The slots the caller resolved this formatter from.
      settings,
      showError: true,
    });
    if (!result || !result.success) {
      return false;
    }

    yield* Effect.logInfo(`Formatted ${filePath}`).pipe(
      withLogChannel(CHANNEL),
    );
    return true;
  },
  Effect.catch((err) =>
    Effect.logError(`Error running tex-fmt: ${toErrorMessage(err)}`).pipe(
      withLogChannel(CHANNEL),
      Effect.as(false),
    ),
  ),
);
