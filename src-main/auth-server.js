const http = require('http');
const log = require('electron-log');

/**
 * Localhost OAuth callback server
 * Handles the redirect from OAuth providers to complete authentication
 */
class AuthServer {
  constructor() {
    this.server = null;
    this.port = 2999;
    this.onTokenReceived = null;
  }

  /**
   * Start the auth server
   * @param {Function} onTokenReceived - Callback when token is received
   * @returns {Promise<number>} - The port the server is listening on
   */
  async start(onTokenReceived) {
    if (this.server) {
      return this.port;
    }

    this.onTokenReceived = onTokenReceived;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url, `http://localhost:${this.port}`);
          
          if (url.pathname === '/auth') {
            const token = url.searchParams.get('token');
            if (token) {
              log.info('Received OAuth token via localhost callback');
              
              // Call the token received callback
              if (this.onTokenReceived) {
                this.onTokenReceived(token);
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
              res.end('Missing token parameter');
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
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        log.info(`Auth server listening on http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });

      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          // Port is in use, try next port
          this.port++;
          this.start(onTokenReceived).then(resolve).catch(reject);
        } else {
          log.error('Auth server error:', error);
          reject(error);
        }
      });
    });
  }

  /**
   * Stop the auth server
   */
  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.onTokenReceived = null;
      log.info('Auth server stopped');
    }
  }

  /**
   * Get the current server port
   * @returns {number|null} - The port or null if not running
   */
  getPort() {
    return this.server ? this.port : null;
  }

  /**
   * Check if server is running
   * @returns {boolean}
   */
  isRunning() {
    return this.server !== null;
  }
}

module.exports = { AuthServer };
