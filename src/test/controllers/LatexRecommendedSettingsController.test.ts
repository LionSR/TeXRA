// Standard library imports
import { strict as assert } from 'assert';

// Local imports - controllers
import { LatexRecommendedSettingsController } from '../../controllers/settingsView/LatexRecommendedSettingsController';

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
          'build/': true,
        },
      },
    });

    assert.deepEqual(controller.buildUpdates({ reset: false }), [
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
          'build/': true,
        },
      },
    });

    assert.deepEqual(
      controller.buildUpdates({
        field: 'autoRevealExclude',
        reset: true,
      }),
      [
        {
          key: 'explorer.autoRevealExclude',
          value: { '**/node_modules/': true },
        },
      ],
    );
  });

  it('builds field-specific string reset updates', () => {
    const controller = createController();

    assert.deepEqual(
      controller.buildUpdates({
        field: 'outDir',
        reset: true,
      }),
      [{ key: 'latex-workshop.latex.outDir', value: undefined }],
    );
  });

  it('clears object settings when reset leaves no remaining keys', () => {
    const controller = createController({
      globalValues: {
        'explorer.autoRevealExclude': {
          '**/build/': true,
          'build/': true,
        },
      },
    });

    assert.deepEqual(
      controller.buildUpdates({
        field: 'autoRevealExclude',
        reset: true,
      }),
      [{ key: 'explorer.autoRevealExclude', value: undefined }],
    );
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

    assert.equal(controller.isRecommendedValueSet('outDir'), true);
    assert.equal(controller.isRecommendedValueSet('autoRevealExclude'), true);
  });

  it('treats legacy autoRevealExclude keys as set for migration display', () => {
    const controller = createController({
      explicitlySet: ['explorer.autoRevealExclude'],
      config: {
        'explorer.autoRevealExclude': {
          'build/': true,
        },
      },
    });

    assert.equal(controller.isRecommendedValueSet('autoRevealExclude'), true);
  });

  it('does not report unset or mismatched recommended settings as set', () => {
    const controller = createController({
      explicitlySet: ['latex-workshop.latex.outDir'],
      config: {
        'latex-workshop.latex.outDir': 'build',
      },
    });

    assert.equal(controller.isRecommendedValueSet('outDir'), false);
    assert.equal(controller.isRecommendedValueSet('autoRevealExclude'), false);
  });
});
