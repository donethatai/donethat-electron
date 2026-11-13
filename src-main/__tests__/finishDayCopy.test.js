const fs = require('fs');
const path = require('path');

// The day closes at the user's day end (03:00 by default), not at midnight,
// and Finish day may run after midnight for the previous day.

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('Finish day copy', () => {
  test('the loading message does not promise an automatic finish at midnight', () => {
    const html = read('src/index.html');
    const match = html.match(/<div id="finishDayMessage"[^>]*>([^<]*)<\/div>/);
    expect(match).not.toBeNull();
    expect(match[1]).not.toMatch(/midnight/i);
  });

  test('the empty-summary banner does not assume the summary is for today', () => {
    const dashboard = read('src/dashboard.js');
    const match = dashboard.match(/showBanner\('([^']*)',\s*\{\s*title: 'Empty Summary'/);
    expect(match).not.toBeNull();
    expect(match[1]).not.toMatch(/for today/i);
  });
});
