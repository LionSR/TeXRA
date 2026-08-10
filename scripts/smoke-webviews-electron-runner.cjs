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
const DEFAULT_VIEWPORT = {
  width: 1280,
  height: 900,
};

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

async function waitForRenderedElement(window, view) {
  const { seedMessages = [], tagName } = view;
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
        const seedMessages = ${JSON.stringify(seedMessages)};
        if (seedMessages.length > 0) {
          if (typeof element.handleMessage !== 'function') {
            throw new Error(${JSON.stringify(
              `Cannot seed ${tagName}: handleMessage is unavailable.`,
            )});
          }
          for (const message of seedMessages) {
            element.handleMessage(message);
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
          }
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const unregisteredVscodeElements = [...new Set(
          [
            ...document.querySelectorAll('*'),
            ...[...document.querySelectorAll('*')]
              .flatMap((node) => [...(node.shadowRoot?.querySelectorAll('*') ?? [])]),
          ]
            .map((node) => node.localName)
            .filter((name) => name.startsWith('vscode-'))
        )]
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

async function assertWebviewRuntime(window) {
  return window.webContents.executeJavaScript(
    `
      (async () => {
        function collectElements(root) {
          const elements = [];
          const visit = (node) => {
            if (!node) return;
            if (node.nodeType === Node.ELEMENT_NODE) {
              elements.push(node);
              if (node.shadowRoot) {
                for (const child of node.shadowRoot.children) visit(child);
              }
            }
            for (const child of node.children ?? []) visit(child);
          };
          visit(root.documentElement ?? root);
          return elements;
        }

        function collectCodiconNames() {
          const names = new Set();
          for (const sheet of document.styleSheets) {
            let rules;
            try {
              rules = sheet.cssRules;
            } catch {
              continue;
            }
            for (const rule of rules) {
              const selectorText = rule.selectorText ?? '';
              for (const match of selectorText.matchAll(/\\.codicon-([a-z0-9-]+)(?=[:\\s,.#\\[]|$)/g)) {
                names.add(match[1]);
              }
            }
          }
          return names;
        }

        // Walk the rendered tree first. The webviews migrated most icon
        // usage to Web Awesome (\`<wa-icon>\`); the codicon font + CSS
        // is only required when the template still ships
        // \`.codicon-*\` classes or \`icon="codicon-*"\` attrs. If no
        // codicons are rendered, the font load + CSS-rule checks are a
        // no-op (this prevents a macOS-only flake where the font is not
        // resolvable but no consumer needs it).
        const elements = collectElements(document);
        const usedCodiconClasses = new Set();
        const usedCodiconIconAttrs = new Set();
        for (const element of elements) {
          for (const className of element.classList ?? []) {
            if (!className.startsWith('codicon-')) continue;
            if (className === 'codicon-modifier-spin') continue;
            usedCodiconClasses.add(className);
          }

          const iconAttr = element.getAttribute?.('icon');
          if (iconAttr && iconAttr.startsWith('codicon-')) {
            usedCodiconIconAttrs.add(iconAttr);
          }
        }

        const codiconUsageCount =
          usedCodiconClasses.size + usedCodiconIconAttrs.size;

        let codiconNames = new Set();
        if (codiconUsageCount > 0) {
          const codiconFonts = await document.fonts.load('16px "codicon"');
          if (codiconFonts.length === 0) {
            throw new Error('Codicon font is not available to the webview.');
          }

          codiconNames = collectCodiconNames();
          if (codiconNames.size === 0) {
            throw new Error('No codicon CSS rules were loaded.');
          }
        }

        // The codiconUsageCount > 0 guard would be tautological inside these
        // loops (the loop body only iterates when at least one usage was
        // found), so we just check membership directly. If the sets are
        // empty these loops are no-ops.
        const invalidClasses = new Set();
        const invalidIconAttrs = new Set();
        for (const className of usedCodiconClasses) {
          const iconName = className.replace(/^codicon-/, '');
          if (!codiconNames.has(iconName)) invalidClasses.add(className);
        }
        for (const iconAttr of usedCodiconIconAttrs) {
          const iconName = iconAttr.replace(/^codicon-/, '');
          if (!codiconNames.has(iconName)) invalidIconAttrs.add(iconAttr);
        }

        if (invalidClasses.size > 0 || invalidIconAttrs.size > 0) {
          throw new Error(
            [
              invalidClasses.size > 0
                ? \`Unknown codicon classes: \${[...invalidClasses].sort().join(', ')}\`
                : '',
              invalidIconAttrs.size > 0
                ? \`Unknown icon attributes: \${[...invalidIconAttrs].sort().join(', ')}\`
                : '',
            ].filter(Boolean).join('; '),
          );
        }

        const texraWebAwesomeIcons = elements.filter(
          (element) =>
            element.localName === 'wa-icon' &&
            element.getAttribute('library') === 'texra',
        );
        const missingWebAwesomeIcons = [];
        for (const icon of texraWebAwesomeIcons) {
          if (icon.updateComplete && typeof icon.updateComplete.then === 'function') {
            await Promise.race([
              icon.updateComplete,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error(\`Timed out waiting for Web Awesome icon: \${icon.getAttribute('name') ?? ''}\`)),
                  ${JSON.stringify(RENDER_TIMEOUT_MS)},
                ),
              ),
            ]);
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (!icon.shadowRoot?.querySelector('svg')) {
            missingWebAwesomeIcons.push(icon.getAttribute('name') ?? '(unnamed)');
          }
        }

        if (missingWebAwesomeIcons.length > 0) {
          throw new Error(
            \`Unrendered TeXRA Web Awesome icons: \${[...new Set(missingWebAwesomeIcons)].sort().join(', ')}\`,
          );
        }

        return {
          codiconCount: codiconNames.size,
          iconAttributeCount: elements.filter((element) => element.hasAttribute?.('icon')).length,
          webAwesomeIconCount: texraWebAwesomeIcons.length,
        };
      })();
    `,
    true,
  );
}

async function applyViewFixture(window, view) {
  const fixtureMessages = Array.isArray(view.fixtureMessages)
    ? view.fixtureMessages
    : [];
  if (fixtureMessages.length === 0) return null;

  return window.webContents.executeJavaScript(
    `
      (async () => {
        const messages = ${JSON.stringify(fixtureMessages)};
        for (const message of messages) {
          window.postMessage(message, '*');
        }

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const app = document.querySelector(${JSON.stringify(view.tagName)});
        if (app?.updateComplete && typeof app.updateComplete.then === 'function') {
          await app.updateComplete;
        }

        const fileGroups = [...(app?.shadowRoot?.querySelectorAll('file-select-group') ?? [])];
        for (const group of fileGroups) {
          if (group.updateComplete && typeof group.updateComplete.then === 'function') {
            await group.updateComplete;
          }
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        if (${JSON.stringify(view.name)} !== 'main') {
          return { fixtureMessages: messages.length };
        }

        const fileItems = fileGroups.flatMap((group) => [
          ...(group.shadowRoot?.querySelectorAll('.file-item') ?? []),
        ]);
        const folderLabels = fileGroups.flatMap((group) => [
          ...(group.shadowRoot?.querySelectorAll('.file-folder') ?? []),
        ]);
        const rawText = document.body.innerText.replace(/\\s+/g, ' ');
        if (rawText.includes('None appendix.tex coverLetter.tex main.tex')) {
          throw new Error('Main view file select options are visible as raw fallback text.');
        }
        if (fileItems.length < 8) {
          throw new Error(\`Main view fixture rendered too few file rows: \${fileItems.length}\`);
        }
        if (folderLabels.length < 4) {
          throw new Error(\`Main view fixture did not render folder labels: \${folderLabels.length}\`);
        }

        return {
          fileGroupCount: fileGroups.length,
          fileItemCount: fileItems.length,
          folderLabelCount: folderLabels.length,
        };
      })();
    `,
    true,
  );
}

function createSmokeWindow(errors) {
  const window = new BrowserWindow({
    width: DEFAULT_VIEWPORT.width,
    height: DEFAULT_VIEWPORT.height,
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

async function assertProgressComposerLayout(window, view) {
  return window.webContents.executeJavaScript(
    `
      (async () => {
        // Resting height of the composer, in lines. It sits at two and grows
        // with content up to --textarea-max-height; the six-line resting box
        // it replaced reserved that room for an empty draft. Keep in step
        // with --textarea-min-height in FollowUpInput.ts.
        const COMPOSER_RESTING_ROWS = 2;

        function findDeep(selector, root = document) {
          const direct = root.querySelector?.(selector);
          if (direct) return direct;
          for (const element of root.querySelectorAll?.('*') ?? []) {
            const found = element.shadowRoot ? findDeep(selector, element.shadowRoot) : null;
            if (found) return found;
          }
          return null;
        }

        const composer = findDeep('follow-up-input');
        const dock = findDeep('.conversation-composer-dock');
        const conversationLog = findDeep('.conversation-log');
        const webAwesomeTextarea = composer?.shadowRoot?.querySelector('wa-textarea');
        if (webAwesomeTextarea?.updateComplete) await webAwesomeTextarea.updateComplete;
        const textarea = webAwesomeTextarea?.shadowRoot?.querySelector('textarea');
        const wrapper = webAwesomeTextarea?.shadowRoot?.querySelector('.textarea');

        const missing = [
          ['follow-up-input', composer],
          ['composer dock', dock],
          ['conversation log', conversationLog],
          ['wa-textarea', webAwesomeTextarea],
          ['native textarea', textarea],
          ['textarea wrapper', wrapper],
        ]
          .filter(([, element]) => !element)
          .map(([label]) => label);
        if (missing.length > 0) {
          throw new Error(\`${view.name} missing composer layout elements: \${missing.join(', ')}\`);
        }

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const style = getComputedStyle(textarea);
        const lineHeight = Number.parseFloat(style.lineHeight);
        const paddingBlock =
          Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        const minHeight = Number.parseFloat(style.minHeight);
        const maxHeight = Number.parseFloat(style.maxHeight);
        const expectedMinHeight = COMPOSER_RESTING_ROWS * lineHeight + paddingBlock;
        const expectedMaxHeight = Math.max(
          minHeight,
          Math.min(window.innerHeight * 0.32, 240),
        );
        const initialTextareaRect = textarea.getBoundingClientRect();
        const initialWrapperRect = wrapper.getBoundingClientRect();

        if (
          webAwesomeTextarea.rows !== COMPOSER_RESTING_ROWS ||
          textarea.rows !== COMPOSER_RESTING_ROWS
        ) {
          throw new Error(
            \`${view.name} composer rows did not propagate: host=\${webAwesomeTextarea.rows} native=\${textarea.rows} expected=\${COMPOSER_RESTING_ROWS}\`,
          );
        }
        if (webAwesomeTextarea.resize !== 'vertical' || style.resize !== 'vertical') {
          throw new Error(
            \`${view.name} composer is not vertically resizable: host=\${webAwesomeTextarea.resize} native=\${style.resize}\`,
          );
        }
        if (Math.abs(minHeight - expectedMinHeight) > 3) {
          throw new Error(
            \`${view.name} composer minimum is not \${COMPOSER_RESTING_ROWS} lines: min=\${minHeight.toFixed(1)}px expected=\${expectedMinHeight.toFixed(1)}px\`,
          );
        }
        if (initialTextareaRect.height < minHeight - 1) {
          throw new Error(
            \`${view.name} native textarea rendered below its minimum: rendered=\${initialTextareaRect.height.toFixed(1)}px min=\${minHeight.toFixed(1)}px\`,
          );
        }
        if (maxHeight > 241 || Math.abs(maxHeight - expectedMaxHeight) > 3) {
          throw new Error(
            \`${view.name} composer max-height cap is incorrect: max=\${maxHeight.toFixed(1)}px expected=\${expectedMaxHeight.toFixed(1)}px\`,
          );
        }
        if (Math.abs(initialWrapperRect.height - initialTextareaRect.height) > 2) {
          throw new Error(
            \`${view.name} Web Awesome wrapper is not synchronized initially: wrapper=\${initialWrapperRect.height.toFixed(1)}px textarea=\${initialTextareaRect.height.toFixed(1)}px\`,
          );
        }

        textarea.style.height = '1000px';
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
        );
        const cappedTextareaRect = textarea.getBoundingClientRect();
        const cappedWrapperRect = wrapper.getBoundingClientRect();
        if (cappedTextareaRect.height > maxHeight + 1) {
          throw new Error(
            \`${view.name} native textarea exceeded its cap: rendered=\${cappedTextareaRect.height.toFixed(1)}px max=\${maxHeight.toFixed(1)}px\`,
          );
        }
        if (Math.abs(cappedWrapperRect.height - cappedTextareaRect.height) > 2) {
          throw new Error(
            \`${view.name} Web Awesome wrapper lost sync after resize: wrapper=\${cappedWrapperRect.height.toFixed(1)}px textarea=\${cappedTextareaRect.height.toFixed(1)}px\`,
          );
        }

        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        const composerRect = composer.getBoundingClientRect();
        const dockRect = dock.getBoundingClientRect();
        const logRect = conversationLog.getBoundingClientRect();
        if (
          composerRect.left < -1 ||
          composerRect.right > viewportWidth + 1 ||
          composerRect.width < 250
        ) {
          throw new Error(
            \`${view.name} composer is unusable at narrow width: [\${composerRect.left.toFixed(1)}, \${composerRect.right.toFixed(1)}] in \${viewportWidth}px\`,
          );
        }
        if (
          dockRect.top < -1 ||
          dockRect.bottom > viewportHeight + 1 ||
          dockRect.height > viewportHeight * 0.55 ||
          logRect.height < 100
        ) {
          throw new Error(
            \`${view.name} composer consumed the short viewport: dock=\${dockRect.height.toFixed(1)}px log=\${logRect.height.toFixed(1)}px viewport=\${viewportHeight}px\`,
          );
        }

        return {
          lineHeight,
          logHeight: logRect.height,
          maxHeight,
          minHeight,
          renderedHeight: cappedTextareaRect.height,
          viewportHeight,
          viewportWidth,
          wrapperHeight: cappedWrapperRect.height,
        };
      })();
    `,
    true,
  );
}

async function assertToolEditApprovalLayout(window, view) {
  return window.webContents.executeJavaScript(
    `
      (async () => {
        function findDeep(selector, root = document) {
          const direct = root.querySelector?.(selector);
          if (direct) return direct;
          for (const element of root.querySelectorAll?.('*') ?? []) {
            const found = element.shadowRoot ? findDeep(selector, element.shadowRoot) : null;
            if (found) return found;
          }
          return null;
        }

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const panel = findDeep('tool-edit-request-panel');
        const section = findDeep('.approval-requests');
        const card = findDeep('.approval-request');
        const actions = findDeep('.approval-request__actions');
        const approveButton = findDeep('wa-button[data-action="approve"]');
        const rejectButton = findDeep('wa-button[data-action="reject"]');

        const missing = [
          ['tool-edit-request-panel', panel],
          ['.approval-requests', section],
          ['.approval-request', card],
          ['.approval-request__actions', actions],
          ['approve button', approveButton],
          ['reject button', rejectButton],
        ]
          .filter(([, element]) => !element)
          .map(([label]) => label);
        if (missing.length > 0) {
          throw new Error(\`${view.name} missing approval layout elements: \${missing.join(', ')}\`);
        }

        const viewportWidth = document.documentElement.clientWidth;
        const maxRight = viewportWidth + 1;
        const sectionRect = section.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        const approveRect = approveButton.getBoundingClientRect();
        const rejectRect = rejectButton.getBoundingClientRect();

        const overflow = [
          ['approval section', sectionRect],
          ['approval card', cardRect],
          ['approval actions', actionsRect],
          ['approve button', approveRect],
          ['reject button', rejectRect],
        ].filter(([, rect]) => rect.left < -1 || rect.right > maxRight);
        if (overflow.length > 0) {
          throw new Error(
            \`${view.name} approval layout overflowed viewport \${viewportWidth}px: \${overflow
              .map(([label, rect]) => \`\${label} [\${rect.left.toFixed(1)}, \${rect.right.toFixed(1)}]\`)
              .join('; ')}\`,
          );
        }

        const compactButtonMaxWidth = 120;
        if (approveRect.width > compactButtonMaxWidth || rejectRect.width > compactButtonMaxWidth) {
          throw new Error(
            \`${view.name} approval buttons are too wide: approve=\${approveRect.width.toFixed(
              1,
            )}px reject=\${rejectRect.width.toFixed(1)}px\`,
          );
        }

        return {
          approveWidth: approveRect.width,
          cardRight: cardRect.right,
          rejectWidth: rejectRect.width,
          viewportWidth,
        };
      })();
    `,
    true,
  );
}

async function assertCompactStreamStatusLayout(window, view) {
  return window.webContents.executeJavaScript(
    `
      (async () => {
        function findDeep(selector, root = document) {
          const direct = root.querySelector?.(selector);
          if (direct) return direct;
          for (const element of root.querySelectorAll?.('*') ?? []) {
            const found = element.shadowRoot ? findDeep(selector, element.shadowRoot) : null;
            if (found) return found;
          }
          return null;
        }

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const tabs = findDeep('stream-tabs');
        const row = tabs?.shadowRoot?.querySelector('stream-tab');
        if (row?.updateComplete) await row.updateComplete;
        const select = row?.shadowRoot?.querySelector('#stream-tab-select-button');
        const glyph = row?.shadowRoot?.querySelector('.tab-status-icon');
        const title = row?.shadowRoot?.querySelector('.tab-title');
        const status = row?.shadowRoot?.querySelector('.tab-status');
        const tooltipAnchor = row?.shadowRoot?.querySelector(
          '#stream-tab-select-tooltip-anchor',
        );
        const identityTooltip = row?.shadowRoot?.querySelector(
          'wa-tooltip[for="stream-tab-select-tooltip-anchor"]',
        );
        const childHint = row?.shadowRoot?.querySelector('.compact-subagent-hint');
        const deleteButton = row?.shadowRoot?.querySelector('.tab-delete');
        if (glyph?.updateComplete) await glyph.updateComplete;
        if (identityTooltip?.updateComplete) await identityTooltip.updateComplete;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const missing = [
          ['stream-tabs', tabs],
          ['stream-tab', row],
          ['select target', select],
          ['lifecycle glyph', glyph],
          ['title', title],
          ['status wrapper', status],
          ['tooltip anchor', tooltipAnchor],
          ['identity tooltip', identityTooltip],
          ['delete target', deleteButton],
        ]
          .filter(([, element]) => !element)
          .map(([label]) => label);
        if (missing.length > 0) {
          throw new Error(
            \`${view.name} missing compact status elements: \${missing.join(', ')}\`,
          );
        }

        const viewportWidth = document.documentElement.clientWidth;
        const railRect = tabs.getBoundingClientRect();
        const selectRect = select.getBoundingClientRect();
        const glyphRect = glyph.getBoundingClientRect();
        const deleteRect = deleteButton.getBoundingClientRect();
        const statusStyle = getComputedStyle(status);
        const titleStyle = getComputedStyle(title);
        const epsilon = 0.5;

        if (viewportWidth >= 500 || !tabs.compact) {
          throw new Error(
            \`${view.name} did not activate narrow compact rows: viewport=\${viewportWidth}px compact=\${tabs.compact}\`,
          );
        }
        if (railRect.width < 48) {
          throw new Error(
            \`${view.name} compact rail fell below its 48px minimum: \${railRect.width.toFixed(2)}px\`,
          );
        }
        if (glyphRect.width <= 0.5 || glyphRect.height <= 0.5) {
          throw new Error(
            \`${view.name} lifecycle glyph collapsed: \${glyphRect.width.toFixed(2)}x\${glyphRect.height.toFixed(2)}\`,
          );
        }
        if (
          glyphRect.left < selectRect.left - epsilon ||
          glyphRect.right > selectRect.right + epsilon ||
          glyphRect.top < selectRect.top - epsilon ||
          glyphRect.bottom > selectRect.bottom + epsilon
        ) {
          throw new Error(
            \`${view.name} lifecycle glyph escaped select target: glyph=[\${glyphRect.left.toFixed(2)}, \${glyphRect.top.toFixed(2)}, \${glyphRect.right.toFixed(2)}, \${glyphRect.bottom.toFixed(2)}] select=[\${selectRect.left.toFixed(2)}, \${selectRect.top.toFixed(2)}, \${selectRect.right.toFixed(2)}, \${selectRect.bottom.toFixed(2)}]\`,
          );
        }
        if (deleteRect.width < 24 || deleteRect.height < 24) {
          throw new Error(
            \`${view.name} compact delete target shrank: \${deleteRect.width.toFixed(2)}x\${deleteRect.height.toFixed(2)}\`,
          );
        }
        if (titleStyle.display !== 'none') {
          throw new Error(\`${view.name} compact title still consumes layout width.\`);
        }
        if (statusStyle.maxWidth !== 'none' || statusStyle.overflow !== 'visible') {
          throw new Error(
            \`${view.name} compact status remains capped or clipped: max-width=\${statusStyle.maxWidth} overflow=\${statusStyle.overflow}\`,
          );
        }
        if (childHint !== null) {
          throw new Error(\`${view.name} compact child hint still displaces lifecycle status.\`);
        }
        const selectLabel = select.getAttribute('aria-label');
        if (!selectLabel?.includes('1 background task')) {
          throw new Error(\`${view.name} compact child count is missing from the accessible name.\`);
        }
        if (select.hasAttribute('aria-labelledby')) {
          throw new Error(\`${view.name} compact tooltip overrides the select target's accessible name.\`);
        }
        if (
          !identityTooltip.id ||
          !tooltipAnchor.getAttribute('aria-labelledby')?.split(' ').includes(identityTooltip.id)
        ) {
          throw new Error(\`${view.name} compact tooltip is not initialized on its wrapper anchor.\`);
        }
        if (!identityTooltip.textContent?.includes('A long compact execution title')) {
          throw new Error(\`${view.name} compact identity tooltip does not expose the session title.\`);
        }

        return {
          deleteHeight: deleteRect.height,
          deleteWidth: deleteRect.width,
          glyphHeight: glyphRect.height,
          glyphWidth: glyphRect.width,
          railWidth: railRect.width,
          selectHeight: selectRect.height,
          selectWidth: selectRect.width,
          viewportWidth,
        };
      })();
    `,
    true,
  );
}

async function assertViewSpecificLayout(window, view) {
  const assertions = Array.isArray(view.assertions) ? view.assertions : [];
  for (const assertion of assertions) {
    switch (assertion) {
      case 'progressComposerLayout': {
        const result = await assertProgressComposerLayout(window, view);
        console.log(
          `Verified ${view.name} progress composer layout: ${JSON.stringify(
            result,
          )}`,
        );
        break;
      }
      case 'toolEditApprovalLayout': {
        const result = await assertToolEditApprovalLayout(window, view);
        console.log(
          `Verified ${view.name} tool edit approval layout: ${JSON.stringify(
            result,
          )}`,
        );
        break;
      }
      case 'compactStreamStatusLayout': {
        const result = await assertCompactStreamStatusLayout(window, view);
        console.log(
          `Verified ${view.name} compact narrow-row layout: ${JSON.stringify(
            result,
          )}`,
        );
        break;
      }
      default:
        throw new Error(`Unknown webview smoke assertion: ${assertion}`);
    }
  }
}

async function smokeView(window, view, outputDir, errors) {
  errors.length = 0;
  const viewport = view.viewport ?? DEFAULT_VIEWPORT;
  window.setBounds({ width: viewport.width, height: viewport.height });
  window.webContents.setZoomFactor(1);
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
  if (result.textLength + result.shadowTextLength === 0) {
    throw new Error(`${view.name} rendered no visible text content.`);
  }
  if (errors.length > 0) {
    throw new Error(`${view.name} console errors:\n${errors.join('\n')}`);
  }
  await assertWebviewRuntime(window);
  const fixtureResult = await applyViewFixture(window, view);
  await assertViewSpecificLayout(window, view);

  const screenshotPath = path.join(outputDir, `${view.name}.png`);
  const image = await window.webContents.capturePage();
  await writeFile(screenshotPath, image.toPNG());
  console.log(
    `Rendered ${view.name}: ${result.width}x${result.height}, screenshot ${screenshotPath}${
      fixtureResult ? `, fixture ${JSON.stringify(fixtureResult)}` : ''
    }`,
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
