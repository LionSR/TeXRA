// Local imports - agent
import { AgentType } from '@agent/core/AgentDataclass';
import type { NamedOutputFile } from '../types';
import type { OutputHandler } from '../OutputHandler';
import type { OutputProcessingStrategy } from './OutputProcessingStrategy';

// Local imports - events
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - log
import { MESSAGE_TYPES } from '@logger/messageTypes';

/** Strategy for processing a single output file. */
export class SingleOutputStrategy implements OutputProcessingStrategy {
  public async process(
    outputFile: string,
    currRound: number,
    handler: OutputHandler,
  ): Promise<void> {
    const logger = handler.getLogger();
    const activeGroupId = handler.getActiveLogGroupId();

    logger.debug(`Processing single output for ${outputFile}`, activeGroupId);

    try {
      let processed: NamedOutputFile = {
        source: outputFile,
        path: outputFile,
      };

      if (handler.agentSetting.agentType === AgentType.CoT) {
        processed = await handler.xmlManager.processSingleXmlOutput(outputFile);
      }

      if (processed && processed.path) {
        await handler.indentLatexFile(processed.path);
        logger.debug(
          `Indented single output file: ${processed.path}`,
          activeGroupId,
        );

        handler.outputFiles[currRound] = [processed.path];
        handler.outputMappings[currRound] = [processed];
      } else {
        logger.debug(
          `No processed file was generated from ${outputFile}`,
          activeGroupId,
        );
        handler.outputFiles[currRound] = [];
        handler.outputMappings[currRound] = [];
      }
    } catch (err) {
      logger.debug(
        `Error processing output file: ${
          err instanceof Error ? err.message : String(err)
        }`,
        activeGroupId,
        MESSAGE_TYPES.INTERNAL,
      );

      const missingOutputsData = {
        missing: [],
        xmlFile: outputFile,
        documentTag: handler.agentSetting.documentTag,
      };
      logger.missingOutputs(missingOutputsData, activeGroupId);

      bus.emit('updateMissingOutputs', {
        stream: handler.getChannel(),
        filesByRound: { [currRound]: [] },
      });

      handler.outputFiles[currRound] = [];
      handler.outputMappings[currRound] = [];
    }
  }
}
