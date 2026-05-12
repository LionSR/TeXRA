// Local imports - log
import * as logger from '@agent/core/logger';
import { getConfig } from '@agent/core/config';
import { toErrorMessage } from '@common/errors';
import { runToolWithCheck } from '@utils/system';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export async function runTexFmt(filePath: string): Promise<boolean> {
  try {
    const texfmtConfig = getConfig<string>('texra.latex.texfmtConfig');

    const args: string[] = [];
    if (texfmtConfig) {
      args.push('--config', texfmtConfig);
    } else {
      args.push('--nowrap');
    }
    args.push(filePath);

    const result = await runToolWithCheck('tex-fmt', args, {
      channel: CHANNEL,
      showError: true,
    });
    if (!result || !result.success) {
      return false;
    }

    logger.info(CHANNEL, `Formatted ${filePath}`);
    return true;
  } catch (err) {
    logger.error(CHANNEL, `Error running tex-fmt: ${toErrorMessage(err)}`);
    return false;
  }
}
