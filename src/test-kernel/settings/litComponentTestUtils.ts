import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach } from 'vitest';

const domGlobalKeys = [
  'window',
  'document',
  'Document',
  'customElements',
  'HTMLElement',
  'HTMLInputElement',
  'CustomEvent',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'ShadowRoot',
] as const;

/**
 * Install the browser globals Lit components need, import the component module,
 * and reset the document between tests.
 */
export function useLitComponentTestDom(
  importComponents: () => Promise<unknown>,
): void {
  let dom: JSDOM;
  const previousGlobals = new Map<
    (typeof domGlobalKeys)[number],
    { hadValue: boolean; value: unknown }
  >();

  beforeAll(async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://texra.local',
    });

    const replacements = {
      window: dom.window,
      document: dom.window.document,
      Document: dom.window.Document,
      customElements: dom.window.customElements,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      CustomEvent: dom.window.CustomEvent,
      Event: dom.window.Event,
      KeyboardEvent: dom.window.KeyboardEvent,
      MouseEvent: dom.window.MouseEvent,
      ShadowRoot: dom.window.ShadowRoot,
    } satisfies Record<(typeof domGlobalKeys)[number], unknown>;

    for (const key of domGlobalKeys) {
      previousGlobals.set(key, {
        hadValue: Object.hasOwn(globalThis, key),
        value: globalThis[key as keyof typeof globalThis],
      });
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: replacements[key],
      });
    }

    await importComponents();
  });

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterAll(() => {
    dom.window.close();
    for (const key of domGlobalKeys) {
      const previous = previousGlobals.get(key);
      if (previous?.hadValue) {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value: previous.value,
        });
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
}
