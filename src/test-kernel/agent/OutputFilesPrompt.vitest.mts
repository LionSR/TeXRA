import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentSetting } from '@agent/core/AgentDataclass';
import { resolveOutputFiles } from '@agent/utils/userVars';

describe('output file prompt variables', () => {
  it('exposes declared generated outputs without using an order variable', () => {
    const agentConfig = {
      outputFiles: ['main.tex', 'appendix.tex'],
    } as AgentConfig;
    const vars = resolveOutputFiles(agentConfig, {} as AgentSetting);

    expect(vars).toEqual({ OUTPUT_FILES: ['main.tex', 'appendix.tex'] });
    expect(agentConfig.outputFiles).toEqual(['main.tex', 'appendix.tex']);
  });

  it('falls back to default generated outputs', () => {
    const agentConfig = {} as AgentConfig;
    const vars = resolveOutputFiles(agentConfig, {
      defaultOutputFiles: ['slides.tex'],
    } as AgentSetting);

    expect(vars).toEqual({ OUTPUT_FILES: ['slides.tex'] });
    expect(agentConfig.outputFiles).toEqual(['slides.tex']);
  });

  it('uses input files internally without exposing a separate output order', () => {
    const agentConfig = {
      inputFiles: ['main.tex', 'appendix.tex'],
      outputFiles: [],
    } as unknown as AgentConfig;
    const vars = resolveOutputFiles(agentConfig, {
      defaultOutputFiles: [],
    } as unknown as AgentSetting);

    expect(vars).toEqual({});
    expect(agentConfig.outputFiles).toEqual(['main.tex', 'appendix.tex']);
  });
});
