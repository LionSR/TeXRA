// Third-party imports
import { Effect } from 'effect';

// Local imports - log
import { withLogChannel, type SettingsStores } from '@texra-ai/harness/plugins';
import { runTool } from '@texra/utils/system/toolChecks';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';

export const runTexFmt = Effect.fn('latex.runTexFmt')(function* (
  filePath: string,
  workspaceRoot: string | undefined,
  texfmtConfig: string,
  settings: SettingsStores,
) {
  const args = [
    ...(texfmtConfig ? ['--config', texfmtConfig] : ['--nowrap']),
    filePath,
  ];

  const result = yield* runTool('tex-fmt', args, {
    cwd: workspaceRoot,
    // The slots the caller resolved this formatter from.
    settings,
  });
  if (!result.success) return false;

  yield* Effect.logInfo(`Formatted ${filePath}`);
  return true;
}, withLogChannel(CHANNEL));
