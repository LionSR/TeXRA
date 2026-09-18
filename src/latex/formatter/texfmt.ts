// Third-party imports
import { Effect } from 'effect';

// Local imports - log
import { createLog } from '@logger/logUtils';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';

const log = createLog(CHANNEL);

export const TEXFMT_CONFIG_KEY = 'texra.latex.texfmtConfig';

export const runTexFmt = Effect.fn('latex.runTexFmt')(
  function* (
    filePath: string,
    workspaceRoot: string | undefined,
    texfmtConfig: string | undefined = getConfig<string>(TEXFMT_CONFIG_KEY),
  ) {
    const args = [
      ...(texfmtConfig ? ['--config', texfmtConfig] : ['--nowrap']),
      filePath,
    ];

    const result = yield* Effect.tryPromise({
      try: () =>
        runToolWithCheck('tex-fmt', args, {
          channel: CHANNEL,
          cwd: workspaceRoot,
          showError: true,
        }),
      catch: (cause) => cause,
    });
    if (!result || !result.success) {
      return false;
    }

    log.info(`Formatted ${filePath}`);
    return true;
  },
  Effect.catch((err) =>
    Effect.sync(() => {
      log.error(`Error running tex-fmt: ${toErrorMessage(err)}`);
      return false;
    }),
  ),
);
