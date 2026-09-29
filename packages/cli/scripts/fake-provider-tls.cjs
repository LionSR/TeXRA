// Test-only preload: point the real CLI's model traffic at a local fake.
//
// Model requests go through undici's own fetch (longRunningModelTransport),
// which no `globalThis.fetch` patch reaches, so this redirects the TLS
// connections instead: a connection to a host in TEXRA_FAKE_HOSTS lands on an
// in-process HTTPS server (a throwaway self-signed certificate) whose requests
// the Node request listener exported by TEXRA_FAKE_HANDLER answers.
//
//   NODE_OPTIONS="--require <this file>" \
//   TEXRA_FAKE_HOSTS=api.anthropic.com TEXRA_FAKE_HANDLER=./handler.cjs \
//   texra run ...
'use strict';
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

const hosts = new Set((process.env.TEXRA_FAKE_HOSTS ?? '').split(','));
const dir = mkdtempSync(path.join(tmpdir(), 'texra-fake-tls-'));
try {
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1'].concat(
      ['-subj', '/CN=texra-fake', '-keyout', `${dir}/key.pem`],
      ['-out', `${dir}/cert.pem`],
    ),
    { stdio: 'ignore' },
  );
  const server = https.createServer(
    {
      key: readFileSync(`${dir}/key.pem`),
      cert: readFileSync(`${dir}/cert.pem`),
    },
    require(path.resolve(process.env.TEXRA_FAKE_HANDLER)),
  );
  server.listen(0, '127.0.0.1').unref();
  const connect = tls.connect;
  tls.connect = function (...args) {
    const options = args.find((arg) => typeof arg === 'object') ?? {};
    if (!hosts.has(options.servername ?? options.host))
      return connect.apply(this, args);
    // The server may still be binding: the TLS socket waits on a plain one
    // that connects once it listens.
    const socket = new net.Socket();
    const dial = () => socket.connect(server.address().port, '127.0.0.1');
    if (server.listening) dial();
    else server.once('listening', dial);
    const redirected = { ...options, socket, rejectUnauthorized: false };
    const callback = args.filter((arg) => typeof arg === 'function');
    return connect.call(this, redirected, ...callback);
  };
  syncBuiltinESMExports();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
