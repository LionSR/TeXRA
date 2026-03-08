// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { readConfig } from '@utils/configBridge';
import { runToolWithCheck } from '@utils/system';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export async function runTexFmt(filePath: string): Promise<boolean> {
  try {
    const texfmtConfig = readConfig<string>('texra.latex.texfmtConfig');

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
