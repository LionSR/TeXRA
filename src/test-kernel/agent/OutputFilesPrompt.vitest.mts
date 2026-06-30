import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import { resolveOutputFiles } from '@agent/utils/userVars';

describe('output file prompt variables', () => {
  it.each([
    {
      name: 'exposes declared generated outputs without using an order variable',
      config: { outputFiles: ['main.tex', 'appendix.tex'] },
      setting: {},
      expectedVars: { OUTPUT_FILES: ['main.tex', 'appendix.tex'] },
      expectedOutputFiles: ['main.tex', 'appendix.tex'],
    },
    {
      name: 'falls back to default generated outputs',
      config: {},
      setting: { defaultOutputFiles: ['slides.tex'] },
      expectedVars: { OUTPUT_FILES: ['slides.tex'] },
      expectedOutputFiles: ['slides.tex'],
    },
    {
      name: 'leaves input-named outputs implicit',
      config: { inputFiles: ['main.tex', 'appendix.tex'], outputFiles: [] },
      setting: { defaultOutputFiles: [] },
      expectedVars: {},
      expectedOutputFiles: [],
    },
    {
      name: 'ignores stale output lists that only name selected inputs',
      config: {
        inputFiles: ['main.tex', 'appendix.tex'],
        outputFiles: ['appendix.tex'],
      },
      setting: { defaultOutputFiles: [] },
      expectedVars: {},
      expectedOutputFiles: [],
    },
  ])('$name', ({ config, setting, expectedVars, expectedOutputFiles }) => {
    const agentConfig = config as unknown as AgentConfig;
    const vars = resolveOutputFiles(
      agentConfig,
      setting as unknown as AgentSetting,
    );

    expect(vars).toEqual(expectedVars);
    expect(agentConfig.outputFiles).toEqual(expectedOutputFiles);
  });
});
