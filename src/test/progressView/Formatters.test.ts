// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports

// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

// Local imports - test

// @ts-ignore: formatter is compiled JS module
import { LogEntryFormatter } from '../../progressView/modules/formatters.js';

describe('LogEntryFormatter DOM', () => {
  it('creates basic log line element', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <template id="logLineTemplate">
        <div class="log-line"><span class="timestamp"></span><span class="level"></span><span class="message"></span></div>
      </template>
    </body></html>`);
    global.document = dom.window.document as any;

    const formatter = new LogEntryFormatter();
    const el = formatter.format({
      id: '1',
      text: 'hello',
      level: 'info',
      timestamp: Date.now(),
      groupId: null,
      messageType: 'info',
      verbose: false,
      data: null,
    } as any);

    assert.ok(el instanceof dom.window.HTMLElement);
    assert.equal(el.querySelector('.message')?.textContent, 'hello');
  });
});
