// Shared setup for the daylight saving tests (main-state-dst-*.test.js). Each
// of those files pins its timezone with timezone-environment.js.
//
// Finish day pauses until the day end. On a daylight saving change the day end
// must land where the server puts it (resolveWallClockInstant in the backend's
// functions/src/utils/logicalDay.ts): a nonexistent time snaps forward to the
// transition instant, an ambiguous one takes the earlier instant.
require('./mocks');
const { resetMocks, mockStore, mockIpcMain } = require('./mocks');

function makeMockWindow() {
  return {
    webContents: { send: jest.fn() },
    show: jest.fn(),
    focus: jest.fn(),
    isDestroyed: () => false
  };
}

function useDstHarness() {
  const ctx = { mainStateModule: null, state: null };

  beforeEach(async () => {
    resetMocks();
    jest.useFakeTimers();
    if (!ctx.mainStateModule) {
      ctx.mainStateModule = require('../main-state');
    }
    ctx.state = await ctx.mainStateModule.initState({
      checkRecording: jest.fn(),
      navigateToView: jest.fn(),
      mainWindow: makeMockWindow(),
      overlayWindow: null
    });
    mockStore.set('userWorkdays', [0, 1, 2, 3, 4, 5, 6]);
    mockStore.set('userWorkhours', { start: '09:00', end: '17:00' });
    ctx.mainStateModule.loadWorkSettings();
    ctx.mainStateModule.resetSessionState();
  });

  afterEach(() => {
    try {
      ctx.mainStateModule.stopStateValidation();
      ctx.mainStateModule.cleanupOnQuit();
    } catch (e) {
      // Ignore cleanup errors
    }
    jest.useRealTimers();
  });

  return {
    setDayEndTime(value) {
      const handler = mockIpcMain.on.mock.calls.find((call) => call[0] === 'updateDayEndTime');
      if (!handler) {
        throw new Error('updateDayEndTime IPC handler was never registered');
      }
      handler[1]({ sender: { getOwnerBrowserWindow: makeMockWindow } }, value);
    },

    // Clicks Finish day at the given UTC instant; returns the pause end as ISO.
    pauseEndAfterFinishDayAt(utcIso) {
      jest.setSystemTime(new Date(utcIso));
      ctx.state.pauseForToday(makeMockWindow());
      return new Date(mockStore.get('pauseState').endTime).toISOString();
    }
  };
}

module.exports = { useDstHarness };
