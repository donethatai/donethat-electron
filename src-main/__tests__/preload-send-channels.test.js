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
    'src/settings.js',
    'src/chat.js',
    'src/app-state.js'
  ])('every channel %s sends on is allowlisted', (relativePath) => {
    const missing = readSentChannels(relativePath).filter((c) => !allowed.has(c));
    expect(missing).toEqual([]);
  });

  test('updateHoliday is allowlisted', () => {
    // Regression: shipped missing, silently dropping every holiday update.
    expect(allowed.has('updateHoliday')).toBe(true);
  });

  test('settings sync forwards dayEndTime through an allowlisted channel', () => {
    expect(readSentChannels('src/settings.js')).toContain('updateDayEndTime');
    expect(allowed.has('updateDayEndTime')).toBe(true);
  });
});

function readPreloadList(name) {
  const source = fs.readFileSync(path.join(ROOT, 'src-main', 'preload.js'), 'utf8');
  const start = source.indexOf(`const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf(']', start));
  return new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

describe('on-device model channels', () => {
  const invokeChannels = [
    'localModel:get-status',
    'localModel:delete',
    'localModel:set-enabled'
  ];

  test.each(invokeChannels)('%s is allowlisted, handled in main and used by settings', (channel) => {
    expect(readPreloadList('validInvokeChannels').has(channel)).toBe(true);
    const mainState = fs.readFileSync(path.join(ROOT, 'src-main', 'main-state.js'), 'utf8');
    expect(mainState).toContain(`ipcMain.handle('${channel}'`);
    const settings = fs.readFileSync(path.join(ROOT, 'src', 'settings.js'), 'utf8');
    expect(settings).toContain(`'${channel}'`);
  });

  test('status events are allowlisted and sent by main', () => {
    expect(readPreloadList('validReceiveChannels').has('localModel:status')).toBe(true);
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    expect(main).toContain("webContents.send('localModel:status'");
  });
});
