import { spawn } from 'node:child_process';

import { formatExit, waitForExit } from './smoke-process-utils.mjs';

/** Render a bundled webview template for an Electron harness. */
export function renderWebviewHtml(template, options) {
  const withTheme = template.replace(
    /<link rel="stylesheet" href="\$\{commonStyleUri\}" \/>/,
    `$&\n    <link rel="stylesheet" href="\${desktopThemeTokensUri}" />`,
  );
  let html = withTheme;
  for (const [key, value] of Object.entries(options.replacements)) {
    html = html.replaceAll(`\${${key}}`, value);
  }

  const bodyTagPattern = /<body\b[^>]*>/i;
  if (!bodyTagPattern.test(html)) {
    throw new Error('Webview template is missing a <body> tag.');
  }
  html = html.replace(
    bodyTagPattern,
    (bodyTag) => `${bodyTag}\n    ${options.bridgeScript}`,
  );

  const attributes = serializeAttributes(
    options.view.attributes,
    options.attributeLabel,
  );
  if (!attributes) return html;

  const tagPattern = new RegExp(`<${options.view.tagName}(?=[\\s>])`, 'i');
  if (!tagPattern.test(html)) {
    throw new Error(`Webview template is missing <${options.view.tagName}>.`);
  }
  return html.replace(tagPattern, `$&${attributes}`);
}

/** Launch an Electron runner and require a successful exit. */
export async function runElectronWebviewHarness(options) {
  const runnerArgs =
    process.env[options.noSandboxEnv] === '1'
      ? ['--no-sandbox', options.runnerPath]
      : [options.runnerPath];
  const child = spawn(options.electronBinaryPath, runnerArgs, {
    cwd: options.cwd,
    env: {
      ...process.env,
      [options.configEnv]: options.configPath,
    },
    stdio: 'inherit',
  });

  const exit = await waitForExit(child);
  if (exit.code === 0) return;
  throw new Error(`${options.failureLabel} failed with ${formatExit(exit)}.`);
}

function serializeAttributes(attributes = {}, label) {
  return Object.entries(attributes)
    .map(([name, value]) => {
      if (!/^[A-Za-z_:][\w:.-]*$/.test(name)) {
        throw new Error(`Invalid ${label} attribute name: ${name}`);
      }
      return ` ${name}="${escapeAttributeValue(value)}"`;
    })
    .join('');
}

function escapeAttributeValue(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * The host bridge a webview acquires, playing the host for one session:
 * the persisted surface (so a selected stream reopens selected), and an
 * events frame in answer to every `subscribe`, cut like `SessionFramer`
 * cuts one. Every request is answered as done.
 */
export function renderSessionHarnessBridge({
  nonce,
  sessionKey,
  owner,
  session,
  messagesKey,
  nowMs,
}) {
  const state = session
    ? {
        [`surface:${sessionKey}`]: {
          selected: session.selected,
          ...session.surface,
        },
      }
    : undefined;
  const source = `
    ${nowMs === undefined ? '' : `Date.now = () => ${nowMs};`}
    const harnessSession = ${JSON.stringify(session ?? null)};
    const harnessLocal = { self: [${JSON.stringify(owner)}], dead: [], unreadable: [] };
    function harnessFrame(subscribe) {
      const named = new Set(subscribe.aggregates.map((aggregate) => aggregate.id));
      const events = harnessSession.events.flatMap((event) => {
        if (event.type !== 'transcript.entry') {
          return [{ _tag: 'event', read: 'listing', event }];
        }
        return named.has(event.aggregateId)
          ? [{ _tag: 'event', read: 'aggregate', event }]
          : [];
      });
      return {
        kind: 'events',
        session: subscribe.session,
        generation: subscribe.generation,
        cursor: harnessSession.events.reduce((max, event) => Math.max(max, event.commit), 0),
        events,
        chunks: [],
        local: harnessLocal,
        host: harnessSession.host,
        replayComplete: true,
        existence: {
          checkedAggregateIds: [...new Set(harnessSession.events.map(event => event.aggregateId))],
          removedAggregateIds: [],
          claims: [...new Set(harnessSession.events.map(event => event.aggregateId))]
            .map(aggregateId => ({ aggregateId, ownerId: ${JSON.stringify(owner)} })),
        },
      };
    }
    const texraHarnessBridge = {
      _state: ${JSON.stringify(state)},
      postMessage(message) {
        (window[${JSON.stringify(messagesKey)} ] ??= []).push(message);
        if (!harnessSession) return;
        if (message.kind === 'subscribe') {
          window.postMessage(harnessFrame(message), '*');
        } else if (message.kind === 'runtime.request' || message.kind === 'host.request') {
          window.postMessage(
            {
              kind: 'response',
              session: message.session,
              requestId: message.requestId,
              result: { ok: true, outcome: { kind: 'done' } },
            },
            '*',
          );
        }
      },
      getState() {
        return this._state;
      },
      setState(state) {
        this._state = state;
      },
    };
    window.__texraHostBridgeApi = texraHarnessBridge;
    window.acquireVsCodeApi = () => texraHarnessBridge;
  `;
  return `<script nonce="${nonce}">${source}</script>`;
}
