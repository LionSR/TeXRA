import { describe, expect, it } from 'vitest';

import { LatexRecommendedSettingsController } from '@controllers/settingsView/LatexRecommendedSettingsController';

function createController(options?: {
  config?: Record<string, unknown>;
  globalValues?: Record<string, unknown>;
  explicitlySet?: string[];
}): LatexRecommendedSettingsController {
  const explicitlySet = new Set(options?.explicitlySet ?? []);
  return new LatexRecommendedSettingsController({
    config: {
      getConfig: (key) => options?.config?.[key],
      getGlobalValue: (key) => options?.globalValues?.[key],
      isExplicitlySet: (key) => explicitlySet.has(key),
    },
  });
}

describe('LatexRecommendedSettingsController', () => {
  it('builds all recommended apply updates', () => {
    const controller = createController({
      globalValues: {
        'explorer.autoRevealExclude': {
          '**/node_modules/': true,
        },
      },
    });

    expect(controller.buildUpdates({ reset: false })).toStrictEqual([
      {
        key: 'latex-workshop.latex.outDir',
        value: '%DIR%/build/',
      },
      {
        key: 'explorer.autoRevealExclude',
        value: {
          '**/node_modules/': true,
          '**/build/': true,
        },
      },
    ]);
  });

  it('builds field-specific reset updates without deleting unrelated values', () => {
    const controller = createController({
      globalValues: {
        'explorer.autoRevealExclude': {
          '**/build/': true,
          '**/node_modules/': true,
        },
      },
    });

    expect(
      controller.buildUpdates({
        field: 'autoRevealExclude',
        reset: true,
      }),
    ).toStrictEqual([
      {
        key: 'explorer.autoRevealExclude',
        value: { '**/node_modules/': true },
      },
    ]);
  });

  it('builds field-specific string reset updates', () => {
    const controller = createController();

    expect(
      controller.buildUpdates({
        field: 'outDir',
        reset: true,
      }),
    ).toStrictEqual([{ key: 'latex-workshop.latex.outDir', value: undefined }]);
  });

  it('clears object settings when reset leaves no remaining keys', () => {
    const controller = createController({
      globalValues: {
        'explorer.autoRevealExclude': {
          '**/build/': true,
        },
      },
    });

    expect(
      controller.buildUpdates({
        field: 'autoRevealExclude',
        reset: true,
      }),
    ).toStrictEqual([{ key: 'explorer.autoRevealExclude', value: undefined }]);
  });

  it('reports recommended string and object settings as set', () => {
    const controller = createController({
      explicitlySet: [
        'latex-workshop.latex.outDir',
        'explorer.autoRevealExclude',
      ],
      config: {
        'latex-workshop.latex.outDir': '%DIR%/build/',
        'explorer.autoRevealExclude': {
          '**/build/': true,
          '**/node_modules/': true,
        },
      },
    });

    expect(controller.isRecommendedValueSet('outDir')).toBe(true);
    expect(controller.isRecommendedValueSet('autoRevealExclude')).toBe(true);
  });

  it('does not report unset or mismatched recommended settings as set', () => {
    const controller = createController({
      explicitlySet: ['latex-workshop.latex.outDir'],
      config: {
        'latex-workshop.latex.outDir': 'build',
      },
    });

    expect(controller.isRecommendedValueSet('outDir')).toBe(false);
    expect(controller.isRecommendedValueSet('autoRevealExclude')).toBe(false);
  });
});
