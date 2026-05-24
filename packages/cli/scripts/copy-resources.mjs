import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const source = path.resolve(packageDir, '../extension/resources');
const target = path.resolve(packageDir, 'dist/resources');
const runtimeResourceEntries = [
  'agents',
  'docs/agent-creation',
  'odyssey',
  'shared',
  'templates/agentCreatorToolUse.yaml',
  'templates/agentCreatorWorkflow.yaml',
  'templates/agentTemplate-toolUse.yaml',
  'templates/agentTemplate-workflowSingle.yaml',
  'templates/instructionPolish.yaml',
  'tool_use_agents',
];

await rm(target, { recursive: true, force: true });
await Promise.all(
  runtimeResourceEntries.map((entry) =>
    cp(path.join(source, entry), path.join(target, entry), {
      recursive: true,
    }),
  ),
);
