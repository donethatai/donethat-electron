// Import mocks FIRST before anything else
require('./mocks');
const { resetMocks, mockIpcMain } = require('./mocks');

/**
 * A user who travels keeps the app running across a timezone change. In the
 * main process `Intl` follows the new system zone but `Date` local time stays
 * on the zone the process started in, so work hours were enforced on the old
 * clock (seen in production: LA work hours 05:00-02:00 paused recording
 * 10:00-13:00 London every day until restart).
 */

const ORIGINAL_TZ = process.env.TZ;
const RealDateTimeFormat = Intl.DateTimeFormat;

let mainStateModule;
let state;

function fakeWindow() {
  return {
    webContents: { send: jest.fn() },
    show: jest.fn(),
    focus: jest.fn(),
    isDestroyed: () => false
  };
}

// Goes through the same IPC path the renderer uses; its handler runs the
// state validation that contains the timezone check.
function setWorkhoursViaIPC(start, end) {
  const handler = mockIpcMain.on.mock.calls.find((call) => call[0] === 'updateWorkhours');
  if (!handler) throw new Error('updateWorkhours handler not registered');
  handler[1]({ sender: { getOwnerBrowserWindow: () => fakeWindow() } }, { start, end });
}

// Makes `Intl` report `zone` without touching `Date`, which is exactly the
// split the main process ends up in after a system timezone change.
function reportSystemZone(zone) {
  jest.spyOn(Intl, 'DateTimeFormat').mockImplementation((...args) => {
    const real = new RealDateTimeFormat(...args);
    return {
      format: real.format.bind(real),
      formatToParts: real.formatToParts.bind(real),
      resolvedOptions: () => ({ ...real.resolvedOptions(), timeZone: zone })
    };
  });
}

beforeEach(async () => {
  resetMocks();
  process.env.TZ = 'America/Los_Angeles';

  if (mainStateModule?.stopStateValidation) {
    try { mainStateModule.stopStateValidation(); } catch (_) {}
  }
  if (!mainStateModule) mainStateModule = require('../main-state');

  state = await mainStateModule.initState({
    checkRecording: jest.fn(),
    navigateToView: jest.fn(),
    mainWindow: fakeWindow(),
    overlayWindow: null
  });

  // First validation records LA as the last known zone. `Intl` is pinned
  // rather than read, so the machine running the tests does not leak in.
  reportSystemZone('America/Los_Angeles');
  setWorkhoursViaIPC('05:00', '02:00');
});

afterEach(() => {
  jest.restoreAllMocks();
  try { state?.stopStateValidation?.(); } catch (_) {}
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('system timezone change while running', () => {
  // Jest hands each test a plain copy of process.env, so assigning TZ here
  // does not reach Node's native setter and `Date` does not actually move
  // (jestjs/jest#9856). This covers the wiring; that Node resets the `Date`
  // cache on TZ assignment is Node's behaviour (nodejs/node#20026, v13+).
  test('a detected zone change is pushed into TZ', () => {
    reportSystemZone('Europe/London');
    setWorkhoursViaIPC('05:00', '02:00'); // runs the validation again

    expect(process.env.TZ).toBe('Europe/London');
  });

  test('an unchanged zone leaves TZ alone', () => {
    setWorkhoursViaIPC('05:00', '02:00');
    expect(process.env.TZ).toBe('America/Los_Angeles');
  });
});
