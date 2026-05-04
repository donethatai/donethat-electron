const http = require('http');
const log = require('electron-log');

/**
 * Localhost OAuth callback server
 * Handles the redirect from OAuth providers to complete authentication
 */
class AuthServer {
  constructor() {
    this.servers = [];
    this.port = 2999;
    this.onTokenReceived = null;
  }

  /**
   * Start the auth server
   * @param {Function} onTokenReceived - Callback when token is received
   * @returns {Promise<number>} - The port the server is listening on
   */
  async start(onTokenReceived) {
    if (this.isRunning()) {
      return this.port;
    }

    this.onTokenReceived = onTokenReceived;

    return new Promise((resolve, reject) => {
      const handleRequest = (req, res) => {
        try {
          const url = new URL(req.url, `http://localhost:${this.port}`);

          if (url.pathname === '/auth') {
            const token = url.searchParams.get('token');
            const idToken = url.searchParams.get('idToken');
            const accessToken = url.searchParams.get('accessToken');
            const action = url.searchParams.get('action');
            const success = url.searchParams.get('success') === 'true';

            if (action === 'linked' && success) {
              if (this.onTokenReceived) {
                this.onTokenReceived(null, { action, success });
              }

              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <html>
                  <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                    <h2>Google Calendar Connected</h2>
                    <p>You can close this tab now</p>
                  </body>
                </html>
              `);
              return;
            }

            if (token || idToken) {
              if (this.onTokenReceived) {
                this.onTokenReceived(token, { idToken, accessToken });
              }

              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <html>
                  <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                    <h2>Authentication Successful</h2>
                    <p>You can close this tab now</p>
                  </body>
                </html>
              `);
            } else {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('Missing token or idToken parameter');
            }
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
          }
        } catch (error) {
          log.error('Error handling auth callback:', error);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal server error');
        }
      };

      const server4 = http.createServer(handleRequest);
      const server6 = http.createServer(handleRequest);

      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        resolve(this.port);
      };

      const teardownAndRetryPort = () => {
        try {
          server4.close();
        } catch (_) {}
        try {
          server6.close();
        } catch (_) {}
        this.servers = [];
        this.port++;
        this.start(onTokenReceived).then(resolve).catch(reject);
      };

      server4.once('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          teardownAndRetryPort();
          return;
        }
        this.servers = [];
        log.error('Auth server error:', error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      server4.listen(this.port, '127.0.0.1', () => {
        this.servers = [server4];

        server6.once('error', (err) => {
          log.warn(
            'Auth server: IPv6 loopback (::1) not available, using IPv4 only:',
            err.code || err.message,
          );
          settleOk();
        });

        server6.listen(this.port, '::1', () => {
          this.servers.push(server6);
          settleOk();
        });
      });
    });
  }

  /**
   * Stop the auth server
   */
  stop() {
    for (const s of this.servers) {
      try {
        s.close();
      } catch (_) {}
    }
    this.servers = [];
    this.onTokenReceived = null;
  }

  /**
   * Get the current server port
   * @returns {number|null} - The port or null if not running
   */
  getPort() {
    return this.isRunning() ? this.port : null;
  }

  /**
   * Check if server is running
   * @returns {boolean}
   */
  isRunning() {
    return this.servers.length > 0;
  }
}

module.exports = { AuthServer };
