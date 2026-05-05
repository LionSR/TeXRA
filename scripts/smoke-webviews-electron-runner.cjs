const { app, BrowserWindow } = require('electron');
const { mkdirSync } = require('node:fs');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');

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
  return window.webContents.executeJavaScript(
    `
      (async () => {
        await customElements.whenDefined(${JSON.stringify(tagName)});
        const element = document.querySelector(${JSON.stringify(tagName)});
        if (!element) {
          throw new Error('Missing rendered element: ${tagName}');
        }
        if (element.updateComplete && typeof element.updateComplete.then === 'function') {
          await element.updateComplete;
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
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
  const result = await waitForRenderedElement(window, view.tagName);
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
  mkdirSync(config.outputDir, { recursive: true });
  const errors = [];
  const window = createSmokeWindow(errors);
  const renderedViews = [];
  try {
    for (const view of config.views) {
      await smokeView(window, view, config.outputDir, errors);
      renderedViews.push(view.name);
    }
  } finally {
    window.destroy();
  }
  if (renderedViews.length !== config.views.length) {
    throw new Error(
      `Rendered ${renderedViews.length} of ${config.views.length} webviews.`,
    );
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
