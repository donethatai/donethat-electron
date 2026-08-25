const fs = require('fs');
const path = require('path');

// Renderer modules send through window.electronAPI, which drops any channel
// missing from validSendChannels in preload.js. Unit tests that call an
// ipcMain handler directly bypass that allowlist, so a channel can be fully
// tested and still be dead in production. This asserts the two stay in sync.

const ROOT = path.join(__dirname, '..', '..');

function readAllowedSendChannels() {
  const source = fs.readFileSync(path.join(ROOT, 'src-main', 'preload.js'), 'utf8');
  const start = source.indexOf('const validSendChannels');
  expect(start).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf(']', start));
  return new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function readSentChannels(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  return [...new Set(
    [...source.matchAll(/ipcRenderer\.send\(\s*'([^']+)'/g)].map((m) => m[1])
  )];
}

describe('preload send channel allowlist', () => {
  const allowed = readAllowedSendChannels();

  test.each([
    'src/settings.js'
  ])('every channel %s sends on is allowlisted', (relativePath) => {
    const missing = readSentChannels(relativePath).filter((c) => !allowed.has(c));
    expect(missing).toEqual([]);
  });

  test('updateHoliday is allowlisted', () => {
    // Regression: shipped missing, silently dropping every holiday update.
    expect(allowed.has('updateHoliday')).toBe(true);
  });
});
