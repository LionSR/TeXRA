// Scratch reproduction of the agent-picker timing fault; never merged.
import { dismissOnboarding, expect, showLauncher, test } from './electronApp.js';

for (const delayed of [true, false]) {
  test(`agent picker repro, frames delayed: ${delayed}`, async ({
    launched,
  }) => {
    const { page } = launched;
    await dismissOnboarding(page);
    await showLauncher(launched);
    await page.evaluate((delay) => {
      const log: string[] = [];
      (window as unknown as { __log: string[] }).__log = log;
      const t0 = performance.now();
      const at = () => Math.round(performance.now() - t0);
      const desc = (node: unknown) => {
        if (!(node instanceof Element)) return String(node);
        const value = node.getAttribute('value');
        return `${node.localName}${node.id ? `#${node.id}` : ''}${value ? `[${value}]` : ''}${node.isConnected ? '' : '(detached)'}`;
      };
      const deep = (root: Document | ShadowRoot, sel: string): Element | null => {
        const hit = root.querySelector(sel);
        if (hit) return hit;
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const found = deep(el.shadowRoot, sel);
            if (found) return found;
          }
        }
        return null;
      };
      const chip = deep(document, '#composer-agent');
      const dropdown = chip?.closest('wa-dropdown');
      log.push(`${at()} dropdown ${desc(dropdown)} items ${dropdown?.querySelectorAll('wa-dropdown-item').length}`);
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        document.addEventListener(
          type,
          (event) => {
            const path = event.composedPath().filter((n) => n instanceof Element).slice(0, 4);
            const e = event as MouseEvent;
            log.push(`${at()} ${type} (${e.clientX},${e.clientY}) ${path.map(desc).join(' < ')}`);
          },
          true,
        );
      }
      for (const type of ['wa-show', 'wa-after-show', 'wa-select', 'wa-hide', 'wa-after-hide']) {
        dropdown?.addEventListener(type, (event) => {
          const item = (event as CustomEvent<{ item?: Element }>).detail?.item;
          log.push(`${at()} ${type} target=${desc(event.target)}${item ? ` item=${desc(item)}` : ''} open=${(dropdown as unknown as { open: boolean }).open}`);
        });
      }
      const polish = dropdown?.querySelector('wa-dropdown-item[value="agent:builtIn:polish"]');
      const report = () => {
        const r = polish?.getBoundingClientRect();
        return `polish ${desc(polish)} box=${r ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}` : 'none'}`;
      };
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'childList' && (record.addedNodes.length || record.removedNodes.length))
            log.push(`${at()} childList on ${desc(record.target)} +${[...record.addedNodes].map(desc).join(',')} -${[...record.removedNodes].map(desc).join(',')}`);
          else if (record.type === 'attributes')
            log.push(`${at()} attr ${record.attributeName} on ${desc(record.target)} = ${(record.target as Element).getAttribute(record.attributeName ?? '')}`);
        }
      }).observe(chip?.getRootNode() ?? document, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'active', 'aria-expanded', 'checked'] });
      const menu = dropdown?.shadowRoot?.querySelector('#menu');
      const popup = dropdown?.shadowRoot?.querySelector('wa-popup');
      if (popup?.shadowRoot)
        new MutationObserver(() => log.push(`${at()} popup style ${report()} menu.scrollTop=${menu?.scrollTop} menu.h=${menu?.clientHeight}`)).observe(popup.shadowRoot, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
      log.push(`${at()} ${report()}`);
      if (delay) {
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) => {
          setTimeout(() => raf(cb), 500);
          return 0;
        };
      }
    }, delayed);
    const agentChip = page.locator('#composer-agent');
    await agentChip.click();
    await page
      .locator('session-composer wa-dropdown-item[value="agent:builtIn:polish"]')
      .click();
    try {
      await expect(agentChip).toContainText('polish', { timeout: 5000 });
    } finally {
      const log = await page.evaluate(() => (window as unknown as { __log: string[] }).__log);
      console.log(`--- delayed=${delayed}\n${log.join('\n')}`);
    }
  });
}
