// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

function readSource(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('<stream-conversation>', () => {
  it('declares the @customElement decorator with the expected tag name (static source check)', () => {
    const source = readSource(
      'packages/extension/src/progressView/frontend/components/StreamConversation.ts',
    );

    expect(source).toContain("@customElement('stream-conversation')");
    expect(source).toContain('export class StreamConversation');
  });

  it('subscribes to module-level progressState signals (no per-instance state hoist)', () => {
    const source = readSource(
      'packages/extension/src/progressView/frontend/components/StreamConversation.ts',
    );

    // Reads must come from progressState.ts so the conversation can mount
    // independently of <progress-app> in the desktop three-pane shell.
    expect(source).toMatch(/from '\.\.\/progressState'/);
    expect(source).toContain('streamContext$.get()');
    expect(source).toContain('logContext$.get()');
    expect(source).toContain('permissions$.get()');
    expect(source).toContain('activeProcessOutputs$.get()');
    expect(source).toContain('streamById$.get()');
  });

  it('provides the same Lit contexts that <progress-app> previously provided', () => {
    const source = readSource(
      'packages/extension/src/progressView/frontend/components/StreamConversation.ts',
    );

    // Descendant components consume these contexts; the providers must move
    // with the renderer body so the contexts are still available.
    expect(source).toContain('@provide({ context: streamStateContext })');
    expect(source).toContain('@provide({ context: streamLogContext })');
    expect(source).toContain('@provide({ context: permissionsContext })');
    expect(source).toContain('@provide({ context: processOutputContext })');
    expect(source).toContain('@provide({ context: streamByIdContext })');
  });

  it('renders the same body branches that ProgressApp.renderStreamContent() used to', () => {
    const source = readSource(
      'packages/extension/src/progressView/frontend/components/StreamConversation.ts',
    );

    // Empty (no active stream) → log-list. Process / tool-use / workflow
    // branches preserved verbatim from the prior renderStreamContent().
    expect(source).toContain('<log-list>');
    expect(source).toContain('<process-stream-content>');
    expect(source).toContain('<tool-use-stream-content>');
    expect(source).toContain('<workflow-stream-content>');
    expect(source).toContain('isProcessAgent(streamInfo.agent)');
  });

  it('uses SignalWatcher so module-level signal writes trigger re-render', () => {
    const source = readSource(
      'packages/extension/src/progressView/frontend/components/StreamConversation.ts',
    );

    // SignalWatcher(LitElement) is the canonical way for the conversation
    // body to react to progressState changes without owning the state.
    expect(source).toContain('SignalWatcher(LitElement)');
  });

  it('is mounted by ProgressApp via the side-effect import', () => {
    const source = readSource(
      'packages/extension/src/progressView/frontend/ProgressApp.ts',
    );

    expect(source).toContain("import './components/StreamConversation';");
    expect(source).toContain('<stream-conversation');
  });

  it('removes the @provide context state from <progress-app> (now thin shell)', () => {
    const source = readSource(
      'packages/extension/src/progressView/frontend/ProgressApp.ts',
    );

    // PRD § 7.C: <progress-app> becomes view-header + <wa-split-panel>.
    // The provider responsibility now lives on <stream-conversation>.
    expect(source).not.toContain('streamStateContext');
    expect(source).not.toContain('streamLogContext');
    expect(source).not.toContain('permissionsContext');
    expect(source).not.toContain('processOutputContext');
    expect(source).not.toContain('streamByIdContext');
    // No bespoke renderStreamContent() anymore — the body is one element.
    expect(source).not.toContain('renderStreamContent');
  });
});
