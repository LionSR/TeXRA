// Local imports - types
import { AgentStateGlobal } from '@agent/core/AgentState';
import { NamedOutputFile, OutputFileInfo } from './types';
import { XmlOutputManager } from './XmlOutputManager';
import type { LatexOutputProcessor } from './LatexOutputProcessor';

/** Interface describing OutputHandler behavior used by agents. */
export interface IOutputHandler {
  /** Map of generated output files by round. */
  outputFiles: { [key: number]: string[] };

  /** Mapping of source to processed output files by round. */
  outputMappings: { [key: number]: NamedOutputFile[] };

  /** XML manager for parsing and splitting outputs. */
  xmlManager: XmlOutputManager;

  /** Optional LaTeX processor for formatting and diffing. */
  latexProcessor?: LatexOutputProcessor;

  /** Print token usage and cost statistics. */
  printStatistics(
    stateGlobal: AgentStateGlobal,
    groupId?: string,
  ): Promise<void>;

  /** Process output files from XML or direct input. */
  processOutputFiles(
    outputFile: string,
    currRound: number,
    groupId?: string,
  ): Promise<void>;

  /** Gather mapping and diff stats for output files of a round. */
  gatherOutputFileInfo(currRound: number): Promise<OutputFileInfo[]>;

  /** Validate expected output files for the given round. */
  validateExpectedOutputs(
    outputFile: string,
    currRound: number,
    groupId?: string,
  ): Promise<void>;
}
