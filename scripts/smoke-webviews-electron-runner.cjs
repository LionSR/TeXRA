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
  process.env.TEXRA_WEBVIEW_SMOKE_TIMEOUT_MS,
  10_000,
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

async function waitForRenderedElement(window, tagName) {
  const missingElementMessage = `Missing rendered element: ${tagName}`;
  const timeoutMessage = `Timed out waiting for custom element: ${tagName}`;
  return window.webContents.executeJavaScript(
    `
      (async () => {
        await Promise.race([
          customElements.whenDefined(${JSON.stringify(tagName)}),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(${JSON.stringify(timeoutMessage)})),
              ${JSON.stringify(RENDER_TIMEOUT_MS)},
            ),
          ),
        ]);
        const element = document.querySelector(${JSON.stringify(tagName)});
        if (!element) {
          throw new Error(${JSON.stringify(missingElementMessage)});
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
        const unregisteredVscodeElements = [
          ...document.querySelectorAll('*'),
          ...[...document.querySelectorAll('*')]
            .flatMap((node) => [...(node.shadowRoot?.querySelectorAll('*') ?? [])]),
        ]
          .map((node) => node.localName)
          .filter((name) => name.startsWith('vscode-'))
          .filter((name, index, names) => names.indexOf(name) === index)
          .filter((name) => customElements.get(name) === undefined);
        if (unregisteredVscodeElements.length > 0) {
          throw new Error(
            \`Unregistered VS Code webview elements: \${unregisteredVscodeElements.join(', ')}\`,
          );
        }
        const rect = element.getBoundingClientRect();
        const shadowText = element.shadowRoot?.textContent?.trim() ?? '';
        const lightText = element.textContent?.trim() ?? '';
        return {
          height: rect.height,
          shadowTextLength: shadowText.length,
          textLength: lightText.length,
          width: rect.width,
        };
      })();
    `,
    true,
  );
}

function createSmokeWindow(errors) {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
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

async function smokeView(window, view, outputDir, errors) {
  errors.length = 0;
  await window.loadFile(view.htmlPath);
  let result;
  try {
    result = await waitForRenderedElement(window, view.tagName);
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
  if (result.textLength + result.shadowTextLength === 0) {
    throw new Error(`${view.name} rendered no visible text content.`);
  }
  if (errors.length > 0) {
    throw new Error(`${view.name} console errors:\n${errors.join('\n')}`);
  }

  const screenshotPath = path.join(outputDir, `${view.name}.png`);
  const image = await window.webContents.capturePage();
  await writeFile(screenshotPath, image.toPNG());
  console.log(
    `Rendered ${view.name}: ${result.width}x${result.height}, screenshot ${screenshotPath}`,
  );
}

async function main() {
  const configPath = process.env.TEXRA_WEBVIEW_SMOKE_CONFIG;
  if (!configPath) {
    throw new Error('TEXRA_WEBVIEW_SMOKE_CONFIG is required.');
  }

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!Array.isArray(config.views) || config.views.length === 0) {
    throw new Error('At least one webview smoke target is required.');
  }
  mkdirSync(config.outputDir, { recursive: true });
  const errors = [];
  const window = createSmokeWindow(errors);
  try {
    for (const view of config.views) {
      await smokeView(window, view, config.outputDir, errors);
    }
  } finally {
    window.destroy();
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
