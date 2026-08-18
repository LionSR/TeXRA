// Local imports - log
import { createLog } from '@logger/logUtils';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';

const log = createLog(CHANNEL);

export const TEXFMT_CONFIG_KEY = 'texra.latex.texfmtConfig';

export async function runTexFmt(filePath: string): Promise<boolean> {
  try {
    const texfmtConfig = getConfig<string>(TEXFMT_CONFIG_KEY);

    const args = [
      ...(texfmtConfig ? ['--config', texfmtConfig] : ['--nowrap']),
      filePath,
    ];

    const result = await runToolWithCheck('tex-fmt', args, {
      channel: CHANNEL,
      showError: true,
    });
    if (!result || !result.success) {
      return false;
    }

    log.info(`Formatted ${filePath}`);
    return true;
  } catch (err) {
    log.error(`Error running tex-fmt: ${toErrorMessage(err)}`);
    return false;
  }
}
