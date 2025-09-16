// Local imports - agent
import type { NamedOutputFile } from '../types';
import type { OutputHandler } from '../OutputHandler';
import type { OutputProcessingStrategy } from './OutputProcessingStrategy';

// Local imports - log
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - utilities
import { replaceInputCommands } from '@utils/files';

/** Strategy for processing multiple output files. */
export class MultipleOutputStrategy implements OutputProcessingStrategy {
  public async process(
    outputFile: string,
    currRound: number,
    handler: OutputHandler,
  ): Promise<void> {
    const logger = handler.getLogger();
    const activeGroupId = handler.getActiveLogGroupId();

    logger.debug(
      `Processing multiple outputs for ${outputFile}; outputFiles: ${handler.agentConfig.outputFiles}`,
      activeGroupId,
    );

    try {
      const processedPairs =
        await handler.xmlManager.processMultipleXmlOutputs(outputFile);

      if (processedPairs && processedPairs.length > 0) {
        const processedFiles = processedPairs.map(
          (p: NamedOutputFile) => p.path,
        );
        await handler.indentLatexFiles(processedFiles);
        logger.debug(
          `Indented multiple output files: ${processedFiles.join(',')}`,
          activeGroupId,
        );

        handler.outputFiles[currRound] = processedFiles;
        handler.outputMappings[currRound] = processedPairs;

        if (handler.baseFiles && handler.baseFiles.length > 0) {
          await replaceInputCommands(handler.baseFiles, processedFiles, logger);
        }
      } else {
        logger.debug(
          `No processed files were generated from ${outputFile}`,
          activeGroupId,
        );
        handler.outputFiles[currRound] = [];
        handler.outputMappings[currRound] = [];
      }
    } catch (err) {
      logger.debug(
        `Error processing output files: ${
          err instanceof Error ? err.message : String(err)
        }`,
        activeGroupId,
        MESSAGE_TYPES.INTERNAL,
      );
      handler.outputFiles[currRound] = [];
      handler.outputMappings[currRound] = [];
    }
  }
}
