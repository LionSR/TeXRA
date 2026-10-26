// Local imports
import { Schema } from 'effect';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { documentTaskPatch } from '@texra/agent/output/documentRecipe';
import { DocumentTaskOptionsSchema } from '@texra/shared/plugins/documents';

/**
 * `config` opened on the document recipe of its agent, as a launcher builds
 * it once the catalog resolved an entry with a `task:` block; the outputs
 * stay as the case wrote them.
 */
export function asDocumentTask<
  C extends Pick<AgentConfig, 'agent'> & Partial<AgentConfig>,
>(config: C) {
  const source = config.agentSource ?? 'builtIn';
  const patch = documentTaskPatch(
    {
      agent: config.agent,
      agentSource: config.agentSource,
      inputFiles: config.inputFiles ?? [],
      outputFiles: config.outputFiles ?? [],
    },
    {
      name: config.agent,
      source,
      path: `/agents/${config.agent}.yaml`,
      persona: { prompt: '', tools: [], temperature: 1 },
      blocks: {
        task: {
          rewrite: true,
          outputs: [],
          files: {},
          prefix: '',
          requests: ['Revise.'],
        },
      },
    },
    Schema.decodeUnknownSync(DocumentTaskOptionsSchema)({}),
  );
  if (patch === null) throw new Error('a task entry always patches');
  // The recipe only: the launch's outputs stay as the case wrote them.
  return { ...config, script: patch.script };
}
