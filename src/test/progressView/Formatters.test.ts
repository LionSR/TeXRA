// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports

// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

// Local imports - test

// @ts-ignore: formatter is compiled JS module
import { LogEntryFormatter } from '../../progressView/modules/formatters.js';

describe('LogEntryFormatter DOM', () => {
  const originalDateTimeFormat = Intl.DateTimeFormat;

  function mockDateTimeFormat(
    _locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    // Verify that hour12: false is set for all time formats
    if (options && options.hour !== undefined) {
      assert.equal(
        options.hour12,
        false,
        'hour12 should be false for consistent 24-hour format',
      );
    }

    const prefix =
      options && (options.year || options.dateStyle) ? 'tooltip' : 'time';
    return {
      format(date: Date) {
        return `${prefix}-${date.getTime()}`;
      },
    };
  }

  beforeEach(() => {
    (Intl as any).DateTimeFormat = mockDateTimeFormat as any;
  });

  afterEach(() => {
    (Intl as any).DateTimeFormat = originalDateTimeFormat;
    delete (global as any).document;
    delete (global as any).window;
  });

  it('creates basic log line element', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <template id="logLineTemplate">
        <div class="log-line"><span class="timestamp"></span><span class="level"></span><span class="message"></span></div>
      </template>
    </body></html>`);
    global.document = dom.window.document as any;
    global.window = dom.window as any;

    const formatter = new LogEntryFormatter();
    const timestamp = Date.UTC(2023, 0, 2, 3, 4, 5);
    const el = formatter.format({
      id: '1',
      text: 'hello',
      level: 'info',
      timestamp,
      groupId: null,
      messageType: 'info',
      verbose: false,
      data: null,
    } as any);

    assert.ok(el instanceof dom.window.HTMLElement);
    assert.equal(el.querySelector('.message')?.textContent, 'hello');
    assert.equal(el?.dataset.fullTimestamp, new Date(timestamp).toISOString());
    assert.equal(
      el?.querySelector('.timestamp')?.getAttribute('title'),
      `tooltip-${timestamp}`,
    );
  });

  it('renders progress status entries with native styling', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <template id="nativeStatusTemplate">
        <div class="native-status-line" role="status">
          <span class="native-status-time"></span>
          <span class="native-status-text"></span>
        </div>
      </template>
    </body></html>`);
    global.document = dom.window.document as any;
    global.window = dom.window as any;

    const formatter = new LogEntryFormatter();
    const timestamp = Date.UTC(2023, 6, 4, 12, 0, 0);

    const el = formatter.format({
      id: 'status-1',
      text: '🟢 Starting continuation #1',
      level: 'info',
      timestamp,
      groupId: null,
      messageType: 'progressStatus',
      verbose: false,
      data: null,
    } as any);

    assert.ok(el instanceof dom.window.HTMLElement);
    assert.equal(el?.classList.contains('native-status-line'), true);
    assert.equal(
      el?.querySelector('.native-status-text')?.textContent,
      '🟢 Starting continuation #1',
    );
    assert.equal(el?.dataset.logId, 'status-1');
    assert.equal(
      el?.querySelector('.native-status-time')?.textContent,
      `time-${timestamp}`,
    );
    assert.equal(
      el?.querySelector('.native-status-time')?.getAttribute('title'),
      `tooltip-${timestamp}`,
    );
  });

  it('renders tool use entries from structured data', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <template id="toolUseTemplate">
        <details class="banner-details">
          <summary class="details-summary">
            <i class="toggle-icon"></i>
            <i class="codicon codicon-wrench"></i>
            <span class="tool-use-title">Tool Use</span>
          </summary>
          <div class="banner-content log-entry-content"></div>
        </details>
      </template>
    </body></html>`);
    global.document = dom.window.document as any;
    global.window = dom.window as any;

    const formatter = new LogEntryFormatter();
    const toolLog = {
      tool: 'read_file',
      input: { path: '/tmp/example.tex', range: { start: 1, end: 15 } },
      output: {
        summary: 'Read 3 lines from example.tex',
        output: 'Line 1: α & β\nLine 2: <section>\nLine 3: "quotes" and more',
      },
    };

    const el = formatter.format({
      id: 'tool-1',
      text: 'not-json-content',
      level: 'info',
      timestamp: Date.now(),
      groupId: 'g1',
      messageType: 'toolUse',
      verbose: false,
      data: toolLog,
    } as any);

    assert.ok(el instanceof dom.window.HTMLElement);
    const title = el.querySelector('.tool-use-title')?.textContent ?? '';
    assert.ok(title.includes('Tool Use: read_file'));
    assert.ok(title.includes('Read 3 lines from example.tex'));

    const inputPre = el.querySelector('.tool-use-section pre');
    assert.ok(inputPre);
    assert.ok(inputPre.textContent?.includes('/tmp/example.tex'));

    const outputFull = el.querySelector('.tool-output-full');
    assert.ok(outputFull);
    assert.ok(outputFull.textContent?.includes('Line 2: <section>'));
    assert.ok(outputFull.textContent?.includes('"quotes" and more'));
  });
});
