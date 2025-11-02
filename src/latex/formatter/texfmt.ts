// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig } from '@utils/config';
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
      showError: true, // Consistent with default behavior
    });
    if (!result || !result.success) {
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
