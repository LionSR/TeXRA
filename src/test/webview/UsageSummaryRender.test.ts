// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

// Local imports - progress view
// @ts-ignore: usage manager is a JS module without typings
import { UsageSummary } from '../../progressView/modules/usageManagers.js';
// @ts-ignore: progress view state is a JS module without typings
import { progressViewState } from '../../progressView/modules/progressViewState.js';

describe('UsageSummary badges', () => {
  beforeEach(() => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <span id="runSummary" class="run-summary"></span>
      <template id="usageSummaryBadgeTemplate">
        <vscode-badge class="usage-summary__badge" appearance="secondary">
          <i class="usage-summary__icon codicon" aria-hidden="true"></i>
          <span class="usage-summary__value"></span>
        </vscode-badge>
      </template>
    </body></html>`);
    global.document = dom.window.document as any;
    global.window = dom.window as any;
    progressViewState.taskGroups.clear();
  });

  afterEach(() => {
    delete (global as any).document;
    delete (global as any).window;
    progressViewState.taskGroups.clear();
  });

  it('renders badges with aggregated totals', () => {
    progressViewState.taskGroups.set('group-1', {
      id: 'group-1',
      usage: { inputTokens: 5200, outputTokens: 1875, cost: 1.234 },
    } as any);

    const summary = new UsageSummary();
    summary.update();

    const summaryEl = document.getElementById('runSummary');
    assert.ok(summaryEl, 'summary element should exist');

    const badges = summaryEl?.querySelectorAll('vscode-badge') ?? [];
    assert.equal(badges.length, 3, 'should render three badges');

    const [inputBadge, outputBadge, costBadge] = Array.from(badges);
    assert.equal(
      inputBadge?.querySelector('.usage-summary__value')?.textContent,
      '5k',
      'input badge should abbreviate tokens',
    );
    assert.equal(
      outputBadge?.querySelector('.usage-summary__value')?.textContent,
      '1875',
      'output badge should show exact token count below threshold',
    );
    assert.equal(
      costBadge?.querySelector('.usage-summary__value')?.textContent,
      '$1.234',
      'cost badge should include currency formatting',
    );
    assert.equal(
      summaryEl?.getAttribute('aria-hidden'),
      'false',
      'usage summary should be announced when data is available',
    );
  });

  it('hides badges when no usage is available', () => {
    const summary = new UsageSummary();
    summary.update({ inputTokens: 0, outputTokens: 0, cost: 0 });

    const summaryEl = document.getElementById('runSummary');
    assert.ok(summaryEl, 'summary element should exist');
    assert.equal(summaryEl?.children.length, 0, 'no badges should render');
    assert.equal(
      summaryEl?.getAttribute('aria-hidden'),
      'true',
      'summary container should be hidden without totals',
    );
  });
});
