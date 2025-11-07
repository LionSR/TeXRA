// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

// Local imports - progress view
// @ts-ignore: file list manager is a JS module without typings
import { FileList } from '../../progressView/modules/uiManagers/FileList.js';

describe('FileList empty state', () => {
  beforeEach(() => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="generatedFiles"></div>
      <span id="runSummary">Totals</span>
    </body></html>`);
    global.document = dom.window.document as any;
    global.window = dom.window as any;
  });

  afterEach(() => {
    delete (global as any).document;
    delete (global as any).window;
  });

  it('shows a friendly empty message and refreshes usage summary', () => {
    const summaryElement = document.getElementById('runSummary');
    assert.ok(summaryElement, 'summary element should exist');

    let updateCalled = false;
    const usageSummary = {
      update() {
        updateCalled = true;
        if (summaryElement) {
          summaryElement.textContent = 'Totals (refreshed)';
        }
      },
    } as any;

    const fileList = new FileList(usageSummary);
    fileList.update({});

    const emptyMessage = document.querySelector('.files-empty');
    assert.ok(emptyMessage, 'empty state message should render');
    assert.equal(
      emptyMessage?.textContent?.trim(),
      'No generated files yet. Usage totals are displayed above.',
    );
    assert.equal(updateCalled, true, 'usage summary should refresh');
    assert.equal(
      summaryElement?.textContent,
      'Totals (refreshed)',
      'usage banner should stay populated',
    );
  });
});
