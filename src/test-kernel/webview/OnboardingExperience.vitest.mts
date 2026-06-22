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

function readRepoFile(path: string): string {
  return readFileSync(repoPath(path), 'utf8');
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

  it('keeps walkthrough credential copy aligned with ChatGPT-first onboarding', () => {
    for (const source of [
      readRepoFile('packages/extension/package.json'),
      readRepoFile(
        'packages/extension/resources/walkthroughs/getting-started.md',
      ),
    ]) {
      const chatGptStart = source.indexOf('**Use ChatGPT subscription**');
      const researcherStart = source.indexOf(
        '**Sign in with Researcher Access**',
      );

      expect(chatGptStart).toBeGreaterThanOrEqual(0);
      expect(researcherStart).toBeGreaterThanOrEqual(0);
      expect(chatGptStart).toBeLessThan(researcherStart);
    }
  });

  it('lands first-run extension users on the credential welcome card', () => {
    const source = readRepoFile('packages/extension/src/extension.ts');
    const firstRunBlock = source.slice(source.indexOf('const welcomeKey'));
    const showMainView = firstRunBlock.indexOf(
      "executeCommand('texra.showMainView')",
    );
    const openWalkthrough = firstRunBlock.indexOf(
      "executeCommand('texra.openGettingStarted')",
    );

    expect(showMainView).toBeGreaterThanOrEqual(0);
    expect(openWalkthrough).toBeGreaterThanOrEqual(0);
    expect(showMainView).toBeLessThan(openWalkthrough);
    expect(firstRunBlock).not.toContain(
      "executeCommand('texra.showMultiAgent')",
    );
  });

  it('keeps empty-project onboarding action oriented', () => {
    const source = readWebviewComponent('GettingStartedBanner');

    expect(source).toContain('No LaTeX files yet');
    expect(source).toContain('Run setup to connect TeXRA');
    expect(source).toContain('COMMAND_LINKS.RUN_SETUP_ASSISTANT');
    expect(source).toContain('action-link--primary');
    expect(source).toContain('COMMAND_LINKS.GETTING_STARTED');
    expect(source).not.toContain('Empty project');
  });

  it('keeps the no-workspace welcome view project-first', () => {
    const source = readRepoFile(
      'packages/extension/src/frontend/ui/welcomeView.ts',
    );
    const openWorkspace = source.indexOf(
      'Open a single-folder workspace containing your LaTeX project',
    );
    const credentialPicker = source.indexOf(
      'The main view will show the credential picker',
    );

    expect(openWorkspace).toBeGreaterThanOrEqual(0);
    expect(credentialPicker).toBeGreaterThanOrEqual(0);
    expect(openWorkspace).toBeLessThan(credentialPicker);
    expect(source).toContain('Run setup once to check LaTeX');
  });
});
