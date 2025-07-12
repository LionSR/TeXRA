// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { executeCommand, checkToolInstalled } from '@utils/system';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export async function runTexFmt(filePath: string): Promise<boolean> {
  try {
    if (!(await checkToolInstalled('tex-fmt'))) {
      return false;
    }

    const texfmtConfig = getConfig<string>('latex.texfmtConfig');

    const command = ['tex-fmt'];
    if (texfmtConfig) {
      command.push('--config', texfmtConfig);
    } else {
      command.push('--nowrap');
    }
    command.push(filePath);

    const result = await executeCommand(command, { channel: CHANNEL });
    if (!result.success) {
      return false;
    }

    logger.info(CHANNEL, `Formatted ${filePath}`);
    return true;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error running tex-fmt: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
