import { describe, expect, it } from 'vitest';

import { resolveCliRuntimeCapabilities } from '@cli/runtime/runtimeCapabilities';

describe('CLI runtime capabilities', () => {
  it('projects approval and tool availability into one runtime vector', () => {
    expect(
      resolveCliRuntimeCapabilities({
        mode: 'interactive',
        approvalPolicy: 'ask',
      }),
    ).toEqual({
      approvalPromptsUnavailable: false,
      runtimeUnavailableTools: ['inquiry'],
    });

    expect(
      resolveCliRuntimeCapabilities({
        mode: 'headless',
        approvalPolicy: 'ask',
      }),
    ).toEqual({
      approvalPromptsUnavailable: true,
      runtimeUnavailableTools: ['inquiry'],
    });
  });

  it('merges caller exclusions without duplicating CLI exclusions', () => {
    expect(
      resolveCliRuntimeCapabilities(
        {
          mode: 'headless',
          approvalPolicy: 'never',
        },
        {
          runtimeUnavailableTools: ['inquiry', 'custom_tool'],
        },
      ),
    ).toEqual({
      approvalPromptsUnavailable: true,
      runtimeUnavailableTools: ['inquiry', 'custom_tool'],
    });
  });
});
