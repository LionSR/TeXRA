// Local imports - core
import * as logger from '../logger/logUtils';

const CHANNEL = 'Housekeeping';
logger.initializeLogging(CHANNEL);

export function getAgentFirstNameChunk(agent: string): string {
  logger.debug(CHANNEL, `Getting agent first name chunk for: ${agent}`);
  let result: string;
  if (agent.startsWith('write-')) {
    result = agent.split('-')[1];
  } else {
    result = agent.includes('_') ? agent.split('_')[0] : agent.split('-')[0];
  }
  logger.debug(CHANNEL, `Agent first name chunk resolved to: ${result}`);
  return result;
}

export function getFilePatterns(
  base: string,
  model: string,
  agent: string,
  numRounds: number = 3,
): string[] {
  const patterns: string[] = [];
  const agentFirstNameChunk = getAgentFirstNameChunk(agent);

  for (let round = 0; round < numRounds; round++) {
    patterns.push(
      `${base}_${agentFirstNameChunk}_r${round}_${model}`,
      `${base}_${agentFirstNameChunk}_r${round}_${model}_diff`,
      `${base}_${agentFirstNameChunk}_r${round}_${model}_diffr${round}r${round - 1}`,
      `${base}_${agentFirstNameChunk}_r${round}_full_${model}`,
      `${base}_${agentFirstNameChunk}_r${round}_full_${model}_diff`,
      `${base}_${agentFirstNameChunk}_r${round}_full_${model}_diffr${round}r${round - 1}`,
      `${base}_${agentFirstNameChunk}_r${round}_${model}_thinking`,
    );
  }
  return patterns;
}
