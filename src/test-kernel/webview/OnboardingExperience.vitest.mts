// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test paths
import { repoPath } from '../desktop/desktopTestPaths.mjs';

function readWebviewComponent(name: string): string {
  return readFileSync(
    repoPath(`packages/extension/src/webview/frontend/components/${name}.ts`),
    'utf8',
  );
}

describe('extension onboarding experience', () => {
  it('shows the State 0 path from credential to first review', () => {
    const source = readWebviewComponent('OnboardingWelcomeCard');

    expect(source).toContain('aria-label="Getting started path"');
    expect(source).toContain('1. Connect');
    expect(source).toContain('2. Setup');
    expect(source).toContain('3. Review');
    expect(source).toContain("waIcon('code-compare')");
  });

  it('keeps ChatGPT subscription as the primary credential action', () => {
    const source = readWebviewComponent('OnboardingWelcomeCard');
    const chatGptButtonStart = source.indexOf('id="onboardingChatGptButton"');
    const chatGptButton = source.slice(
      chatGptButtonStart,
      source.indexOf('</wa-button>', chatGptButtonStart),
    );

    expect(chatGptButtonStart).toBeGreaterThanOrEqual(0);
    expect(chatGptButtonStart).toBeLessThan(
      source.indexOf('id="onboardingSignInButton"'),
    );
    expect(chatGptButton).toContain('variant="brand"');
    expect(chatGptButton).toContain('appearance="filled"');
  });

  it('keeps empty-project onboarding action oriented', () => {
    const source = readWebviewComponent('GettingStartedBanner');

    expect(source).toContain('Empty project');
    expect(source).toContain('COMMAND_LINKS.RUN_SETUP_ASSISTANT');
    expect(source).toContain('action-link--primary');
    expect(source).toContain('COMMAND_LINKS.GETTING_STARTED');
    expect(source).not.toContain('Empty folder');
  });
});
