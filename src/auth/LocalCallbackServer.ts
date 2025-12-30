import * as http from 'http';
import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';

/**
 * A temporary HTTP server for handling OAuth callbacks when custom URI schemes
 * (like cursor:// or vscode://) are not registered on the system.
 *
 * This provides a fallback mechanism for authentication in environments where
 * protocol handlers may not work (e.g., remote development, web environments,
 * or systems without proper URI handler registration).
 */
export class LocalCallbackServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private _onDidReceiveCallback = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidReceiveCallback = this._onDidReceiveCallback.event;

  /**
   * Start the local HTTP server on an available port.
   * @returns The port number the server is listening on
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Listen on port 0 to get a random available port
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          logger.info(
            'LocalCallbackServer',
            `Started OAuth callback server on port ${this.port}`,
          );
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('error', (error) => {
        logger.error('LocalCallbackServer', `Server error: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * Get the callback URL for OAuth redirect.
   * Must be called after start().
   */
  getCallbackUrl(): string {
    if (!this.port) {
      throw new Error('Server not started. Call start() first.');
    }
    return `http://127.0.0.1:${this.port}/auth-callback`;
  }

  /**
   * Handle incoming HTTP requests.
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);

    if (url.pathname === '/auth-callback') {
      // Build a URI that matches what the VS Code URI handler would receive
      // The OAuth tokens come in the URL fragment (#access_token=...) but HTTP servers
      // don't receive fragments. Supabase sends them as query params for localhost.
      const fragment = url.search.substring(1); // Remove leading '?'
      const callbackUri = vscode.Uri.parse(
        `http://127.0.0.1:${this.port}/auth-callback#${fragment}`,
      );

      logger.info('LocalCallbackServer', 'Received OAuth callback');

      // Send a success page that closes itself
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getSuccessHtml());

      // Fire the callback event
      this._onDidReceiveCallback.fire(callbackUri);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  }

  /**
   * Get the HTML for the success page.
   */
  private getSuccessHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>TeXRA Authentication</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 1rem;
      backdrop-filter: blur(10px);
    }
    .checkmark {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
    h1 {
      margin: 0 0 0.5rem 0;
      font-weight: 600;
    }
    p {
      margin: 0;
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">✓</div>
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to VS Code.</p>
  </div>
  <script>
    // Try to close the window after a short delay
    setTimeout(() => window.close(), 2000);
  </script>
</body>
</html>`;
  }

  /**
   * Stop the server and clean up resources.
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = null;
      logger.info('LocalCallbackServer', 'Stopped OAuth callback server');
    }
    this._onDidReceiveCallback.dispose();
  }
}
