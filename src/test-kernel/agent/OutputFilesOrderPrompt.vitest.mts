import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentSetting } from '@agent/core/AgentDataclass';
import { getOutputFilesOrder } from '@agent/utils/userVars';
import { renderPrompt } from '@utils/prompt';

describe('OUTPUT_FILES_ORDER prompt variable', () => {
  it('renders as an indexable filename array', async () => {
    const vars = getOutputFilesOrder(
      {
        outputFiles: ['main.tex', 'appendix.tex'],
      } as AgentConfig,
      {} as AgentSetting,
    );

    await expect(
      renderPrompt(
        '<document name="{{ OUTPUT_FILES_ORDER[0] }}">{{ OUTPUT_FILES_ORDER | join(", ") }}</document>',
        vars,
      ),
    ).resolves.toBe(
      '<document name="main.tex">main.tex, appendix.tex</document>',
    );
  });

  it('falls back to default output files as the same array value', async () => {
    const agentConfig = {} as AgentConfig;
    const vars = getOutputFilesOrder(agentConfig, {
      defaultOutputFiles: ['slides.tex'],
    } as AgentSetting);

    expect(vars.OUTPUT_FILES_ORDER).toEqual(['slides.tex']);
    expect(agentConfig.outputFiles).toEqual(['slides.tex']);
  });
});
