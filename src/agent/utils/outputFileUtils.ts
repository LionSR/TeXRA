// Standard library imports
import * as path from 'path';

// Local imports
import { parseKey } from '@agent/index';

/**
 * Extract the clean agent name from an identifier.
 * Handles source:name format (e.g., "custom:summarize" → "summarize").
 */
function getCleanAgentName(agentIdentifier: string): string {
  const parsed = parseKey(agentIdentifier);
  return parsed ? parsed.name : agentIdentifier;
}

/**
 * Generates an output filename incorporating model and round information.
 *
 * @param inputFile The input file path
 * @param agent Agent name (may include source: prefix which will be stripped)
 * @param model Model name
 * @param outputExt Extension for the output file
 * @param currRound Current round number
 * @param editedFile Optional previously edited file for round detection
 */
export function getOutputFileName(
  inputFile: string,
  agent: string,
  model: string,
  outputExt: string,
  currRound: number,
  editedFile?: string,
  options?: {
    outputDir?: string;
  },
): string {
  const { dir, name: fileName } = path.parse(inputFile);
  // Extract clean agent name (strip source: prefix if present)
  const cleanAgent = getCleanAgentName(agent);
  const agentFirstNameChunk = cleanAgent.split('_')[0];

  let newRound = currRound;
  if (editedFile) {
    const match = editedFile.match(/_r(\d+)_/);
    const editedRound = match ? parseInt(match[1]) : 0;
    newRound += editedRound + 1;
  }

  const outputBaseName = `${fileName}_${agentFirstNameChunk}_r${newRound}_${model}.${outputExt}`;
  const targetDir = options?.outputDir ?? dir;
  return path.join(targetDir, outputBaseName);
}
