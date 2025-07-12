// Local imports - types
import { AgentStateGlobal, AgentStateRound } from '@agent/core/AgentState';
import { NamedOutputFile, OutputFileInfo } from './types';

/** Interface describing OutputHandler behavior used by agents. */
export interface IOutputHandler {
  /** Map of generated output files by round. */
  outputFiles: { [key: number]: string[] };

  /** Mapping of source to processed output files by round. */
  outputMappings: { [key: number]: NamedOutputFile[] };

  /** Indent a single LaTeX file for readability. */
  indentLatexFile(filePath: string): Promise<void>;

  /** Indent multiple LaTeX files for readability. */
  indentLatexFiles(filePaths: string[]): Promise<void>;

  /** Filter and clean up raw XML content. */
  processXmlContent(content: string): Promise<string>;

  /** Run latexdiff comparisons for the current round. */
  handleLatexdiffofOutput(currRound: number, groupId?: string): Promise<void>;

  /** Split and process a single XML output file. */
  processSingleXmlOutput(outputFile: string): Promise<NamedOutputFile>;

  /** Split and process multiple XML output files. */
  processMultipleXmlOutputs(outputFile: string): Promise<NamedOutputFile[]>;

  /** Ensure the XML structure in the file is well formed. */
  ensureCorrectXmlStructure(
    filePath: string,
    documentTag: string,
  ): Promise<void>;

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

  /**
   * Finalize a conversation round by collecting file info and validating
   * expected outputs.
   */
  finalizeRound(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    currRound: number,
    roundGroupId?: string,
  ): Promise<OutputFileInfo[]>;
}
