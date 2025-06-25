import type { AgentStateGlobal } from '@agent/core/AgentState';
import type { NamedOutputFile } from './types';

/**
 * Public API surface for {@link OutputHandler}.
 */
export interface IOutputHandler {
  /** Mapping of round index to output file paths. */
  outputFiles: { [key: number]: string[] };
  /** Mapping of round index to named output files. */
  outputMappings: { [key: number]: NamedOutputFile[] };

  startProcessing(processName: string, roundGroupId?: string): Promise<string>;
  endProcessing(status?: 'error' | 'stopped', groupId?: string): void;
  indentLatexFile(filePath: string): Promise<void>;
  indentLatexFiles(filePaths: string[]): Promise<void>;
  processXmlContent(content: string): Promise<string>;
  handleLatexdiffofOutput(currRound: number, groupId?: string): Promise<void>;
  processSingleXmlOutput(outputFile: string): Promise<NamedOutputFile>;
  processMultipleXmlOutputs(outputFile: string): Promise<NamedOutputFile[]>;
  ensureCorrectXmlStructure(
    filePath: string,
    documentTag: string,
  ): Promise<void>;
  printStatistics(
    stateGlobal: AgentStateGlobal,
    groupId?: string,
  ): Promise<void>;
}
