// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

// Local imports - progress view
// @ts-ignore: manager is compiled JS module
import { SessionSelector } from '../../../progressView/modules/uiManagers/SessionSelector.js';

describe('SessionSelector UI manager', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM(`<!doctype html><html><body>
      <div id="sessionSelectorContainer" class="session-selector" aria-hidden="true">
        <label class="session-selector__label" for="sessionSelector">Session</label>
        <select id="sessionSelector" class="session-selector__select"></select>
      </div>
    </body></html>`);

    global.document = dom.window.document as any;
    global.window = dom.window as any;
  });

  afterEach(() => {
    delete (global as any).document;
    delete (global as any).window;
  });

  it('renders options and emits selection changes', () => {
    const manager = new SessionSelector();
    let selected: string | null = null;
    manager.setChangeHandler((groupId: string | null) => {
      selected = groupId;
    });

    manager.update(
      [
        { id: 'group-1', name: 'First run', startTime: 1 },
        { id: 'group-2', name: 'Second run', startTime: 2 },
      ],
      'group-1',
    );

    const container = dom.window.document.getElementById(
      'sessionSelectorContainer',
    );
    const select = dom.window.document.getElementById(
      'sessionSelector',
    ) as HTMLSelectElement;

    assert.ok(container?.classList.contains('is-visible'));
    assert.equal(select.options.length, 2);
    assert.equal(select.value, 'group-1');

    select.value = 'group-2';
    select.dispatchEvent(new dom.window.Event('change'));

    assert.equal(selected, 'group-2');

    manager.update(
      [{ id: 'group-3', name: 'Solo run', startTime: 3 }],
      'group-3',
    );
    assert.equal(
      container?.classList.contains('is-visible'),
      false,
      'selector hides when only one session exists',
    );
  });
});
