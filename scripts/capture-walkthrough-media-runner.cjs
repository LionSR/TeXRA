const { app, BrowserWindow } = require('electron');
const { mkdirSync } = require('node:fs');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const RENDER_TIMEOUT_MS = readPositiveNumber(
  process.env.TEXRA_WALKTHROUGH_CAPTURE_TIMEOUT_MS,
  12_000,
);

function normalizeConsoleMessage(levelOrDetails, message) {
  if (typeof levelOrDetails === 'object' && levelOrDetails !== null) {
    return {
      level: levelOrDetails.level,
      message: levelOrDetails.message,
      sourceId: levelOrDetails.sourceId,
      lineNumber: levelOrDetails.lineNumber,
    };
  }
  return {
    level: levelOrDetails,
    message,
    sourceId: undefined,
    lineNumber: undefined,
  };
}

function isConsoleError(level) {
  return level === 'error' || level === 3;
}

async function execute(window, script) {
  return window.webContents.executeJavaScript(script, true);
}

async function waitForRenderedElement(window, view) {
  const timeoutMessage = `Timed out waiting for custom element: ${view.tagName}`;
  return execute(
    window,
    `
      (async () => {
        await Promise.race([
          customElements.whenDefined(${JSON.stringify(view.tagName)}),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(${JSON.stringify(timeoutMessage)})),
              ${JSON.stringify(RENDER_TIMEOUT_MS)},
            ),
          ),
        ]);
        const element = document.querySelector(${JSON.stringify(view.tagName)});
        if (!element) {
          throw new Error(${JSON.stringify(`Missing rendered element: ${view.tagName}`)});
        }
        if (element.updateComplete && typeof element.updateComplete.then === 'function') {
          await Promise.race([
            element.updateComplete,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(${JSON.stringify(timeoutMessage)})),
                ${JSON.stringify(RENDER_TIMEOUT_MS)},
              ),
            ),
          ]);
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })();
    `,
  );
}

async function flushUpdates(window, tagName) {
  await execute(
    window,
    `
      (async () => {
        function collect(root) {
          const result = [];
          const visit = (node) => {
            if (!node) return;
            if (node.nodeType === Node.ELEMENT_NODE) {
              result.push(node);
              if (node.shadowRoot) {
                for (const child of node.shadowRoot.children) visit(child);
              }
            }
            for (const child of node.children ?? []) visit(child);
          };
          visit(root);
          return result;
        }

        const root = document.querySelector(${JSON.stringify(tagName)}) ?? document.body;
        const elements = collect(root);
        for (const element of elements) {
          if (element.updateComplete && typeof element.updateComplete.then === 'function') {
            await Promise.race([
              element.updateComplete,
              new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(RENDER_TIMEOUT_MS)})),
            ]);
          }
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })();
    `,
  );
}

async function seedMessages(window, view) {
  const messages = Array.isArray(view.messages) ? view.messages : [];
  if (messages.length === 0) return;

  if (view.messageMode === 'postMessage') {
    await execute(
      window,
      `
        (async () => {
          const messages = ${JSON.stringify(messages)};
          for (const message of messages) {
            window.postMessage(message, '*');
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
        })();
      `,
    );
  } else {
    await execute(
      window,
      `
        (async () => {
          const element = document.querySelector(${JSON.stringify(view.tagName)});
          if (!element || typeof element.handleMessage !== 'function') {
            throw new Error(${JSON.stringify(
              `Cannot seed ${view.tagName}: handleMessage is unavailable.`,
            )});
          }
          const messages = ${JSON.stringify(messages)};
          for (const message of messages) {
            element.handleMessage(message);
            if (element.updateComplete && typeof element.updateComplete.then === 'function') {
              await Promise.race([
                element.updateComplete,
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(new Error(${JSON.stringify(
                      `Timed out applying messages to ${view.tagName}.`,
                    )})),
                    ${JSON.stringify(RENDER_TIMEOUT_MS)},
                  ),
                ),
              ]);
            }
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
        })();
      `,
    );
  }

  await flushUpdates(window, view.tagName);
}

function targetScript(target) {
  switch (target) {
    case 'agent-model-selection':
      return `
        const app = document.querySelector('main-app');
        const panel = app?.shadowRoot?.querySelector('instruction-panel');
        const controls = [
          ...(panel?.shadowRoot?.querySelectorAll('.model-selection-footer .select-group') ?? []),
        ];
        if (controls.length === 0) throw new Error('Cannot find agent/model controls.');
        return padRect(unionRects(controls.map((control) => control.getBoundingClientRect())), 10, 8);
      `;
    case 'file-selection':
      return `
        const app = document.querySelector('main-app');
        const root = app?.shadowRoot;
        const details = root?.querySelector('.file-selection-details');
        if (!details) throw new Error('Cannot find file selection details.');
        if (!details.open && typeof details.show === 'function') {
          await details.show();
        } else {
          details.open = true;
        }
        await nextFrame();

        const groups = [...(root.querySelectorAll('file-select-group') ?? [])].slice(0, 4);
        for (const group of groups) {
          group.style.marginBottom = '';
          for (const dropdown of group.shadowRoot?.querySelectorAll('wa-dropdown') ?? []) {
            if (dropdown.open && typeof dropdown.hide === 'function') {
              await dropdown.hide();
            } else {
              dropdown.open = false;
            }
          }
        }
        await nextFrame();
        for (const group of groups) {
          const fileSelect = group.shadowRoot?.querySelector('.file-select');
          const toggle = group.shadowRoot?.querySelector('.toggle-icon');
          if (fileSelect?.dataset?.expanded !== 'true') {
            toggle?.click();
          }
        }
        await nextFrame();

        const summary = root.querySelector('.file-selection-summary');
        const rects = groups
          .map((group) => group.shadowRoot?.querySelector('.file-select')?.getBoundingClientRect())
          .concat(summary?.getBoundingClientRect())
          .filter((rect) => rect && rect.width > 0 && rect.height > 0);
        if (rects.length === 0) throw new Error('Cannot find file selection controls.');
        const rect = unionRects(rects);
        return clipRect({
          x: rect.x - 12,
          y: rect.y - 12,
          width: rect.width + 24,
          height: rect.height + 6,
        });
      `;
    case 'auto-extract-options':
      return `
        const app = document.querySelector('main-app');
        const root = app?.shadowRoot;
        const details = root?.querySelector('.file-selection-details');
        if (!details) throw new Error('Cannot find file selection details.');
        if (!details.open && typeof details.show === 'function') {
          await details.show();
        } else {
          details.open = true;
        }
        await nextFrame();
        const groups = [...(root?.querySelectorAll('file-select-group') ?? [])];
        const mediaGroup = groups.find((group) => group.shadowRoot?.textContent?.includes('Media'));
        if (mediaGroup) {
          mediaGroup.style.marginBottom = '150px';
        }
        mediaGroup?.scrollIntoView({ block: 'center', inline: 'nearest' });
        await nextFrame();
        const fileSelect = mediaGroup?.shadowRoot?.querySelector('.file-select');
        if (fileSelect?.dataset?.expanded === 'true') {
          mediaGroup.shadowRoot?.querySelector('.toggle-icon')?.click();
          await nextFrame();
        }
        const button = mediaGroup?.shadowRoot?.querySelector('#toggleAutoExtract');
        if (!mediaGroup || !button) throw new Error('Cannot find auto-extract control.');
        button.click();
        await nextFrame();
        const dropdown = mediaGroup.shadowRoot.querySelector('wa-dropdown');
        const labelGroup = mediaGroup.shadowRoot.querySelector('.file-select-label-group');
        const menu = dropdown?.shadowRoot?.querySelector('[part~="menu"], [part="menu"]')?.getBoundingClientRect();
        const trigger = button.getBoundingClientRect();
        const rects = [
          labelGroup?.getBoundingClientRect(),
          menu,
          trigger,
        ].filter((rect) => rect && rect.width > 0 && rect.height > 0);
        return padRect(unionRects(rects), 12, 12);
      `;
    case 'api-key-setup':
      return `
        const app = document.querySelector('settings-app');
        const container = app?.shadowRoot?.querySelector('.settings-container');
        if (!container) throw new Error('Cannot find settings container.');
        const rect = container.getBoundingClientRect();
        return clipRect({ x: rect.x, y: rect.y, width: Math.min(rect.width, 1280), height: Math.min(rect.height, 720) });
      `;
    case 'texra-progressboard':
      return `
        const app = document.querySelector('progress-app');
        const rect = app?.getBoundingClientRect();
        if (!rect) throw new Error('Cannot find progress app.');
        return clipRect({ x: rect.x, y: rect.y, width: Math.min(rect.width, 1280), height: Math.min(rect.height, 760) });
      `;
    default:
      throw new Error(`Unknown capture target: ${target}`);
  }
}

async function captureTarget(window, capture) {
  const rect = await execute(
    window,
    `
      (async () => {
        function clipRect(rect) {
          const x = Math.max(0, Math.floor(rect.x));
          const y = Math.max(0, Math.floor(rect.y));
          const maxWidth = window.innerWidth - x;
          const maxHeight = window.innerHeight - y;
          return {
            x,
            y,
            width: Math.max(1, Math.min(Math.ceil(rect.width), maxWidth)),
            height: Math.max(1, Math.min(Math.ceil(rect.height), maxHeight)),
          };
        }
        function padRect(rect, xPad, yPad) {
          return clipRect({
            x: rect.x - xPad,
            y: rect.y - yPad,
            width: rect.width + xPad * 2,
            height: rect.height + yPad * 2,
          });
        }
        function unionRects(rects) {
          const visibleRects = rects.filter((rect) => rect && rect.width > 0 && rect.height > 0);
          if (visibleRects.length === 0) {
            throw new Error('Cannot create a union from an empty rect set.');
          }
          const left = Math.min(...visibleRects.map((rect) => rect.left));
          const top = Math.min(...visibleRects.map((rect) => rect.top));
          const right = Math.max(...visibleRects.map((rect) => rect.right));
          const bottom = Math.max(...visibleRects.map((rect) => rect.bottom));
          return {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
          };
        }
        function nextFrame() {
          return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        ${targetScript(capture.target)}
      })();
    `,
  );

  if (rect.width <= 1 || rect.height <= 1) {
    throw new Error(
      `Invalid capture rect for ${capture.target}: ${JSON.stringify(rect)}`,
    );
  }

  mkdirSync(path.dirname(capture.outputPath), { recursive: true });
  const image = await window.webContents.capturePage(rect);
  await writeFile(capture.outputPath, image.toPNG());
  console.log(
    `Captured ${capture.target}: ${rect.width}x${rect.height} -> ${capture.outputPath}`,
  );
}

function createCaptureWindow(view, errors) {
  const window = new BrowserWindow({
    width: view.width ?? 1280,
    height: view.height ?? 860,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.on(
    'console-message',
    (_event, levelOrDetails, message) => {
      const entry = normalizeConsoleMessage(levelOrDetails, message);
      if (!isConsoleError(entry.level)) return;
      errors.push(
        `${entry.message ?? ''} (${entry.sourceId ?? 'unknown'}:${entry.lineNumber ?? 0})`,
      );
    },
  );
  window.webContents.on('render-process-gone', (_event, details) => {
    errors.push(`Renderer process exited: ${details.reason}`);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    errors.push(`Failed to load ${url}: ${code} ${description}`);
  });
  return window;
}

async function captureView(view) {
  const errors = [];
  const window = createCaptureWindow(view, errors);
  try {
    await window.loadFile(view.htmlPath);
    let result;
    try {
      result = await waitForRenderedElement(window, view);
    } catch (error) {
      if (errors.length === 0) throw error;
      throw new Error(
        `${view.name} render failed: ${
          error instanceof Error ? error.message : String(error)
        }\n${errors.join('\n')}`,
      );
    }
    if (result.width <= 0 || result.height <= 0) {
      throw new Error(
        `${view.name} rendered with invalid bounds: ${result.width}x${result.height}`,
      );
    }
    if (errors.length > 0) {
      throw new Error(`${view.name} console errors:\n${errors.join('\n')}`);
    }
    await seedMessages(window, view);
    for (const capture of view.captures ?? []) {
      await captureTarget(window, capture);
    }
  } finally {
    window.destroy();
  }
}

async function main() {
  const configPath = process.env.TEXRA_WALKTHROUGH_CAPTURE_CONFIG;
  if (!configPath) {
    throw new Error('TEXRA_WALKTHROUGH_CAPTURE_CONFIG is required.');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  for (const view of config.views ?? []) {
    await captureView(view);
  }
}

app
  .whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  });
