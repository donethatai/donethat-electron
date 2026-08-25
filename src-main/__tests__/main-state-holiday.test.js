// Import mocks FIRST before anything else
require('./mocks');

// Test suite for the holiday window overriding workdays
const { createTestDate } = require('./test-helpers');
const { resetMocks, mockStore, mockIpcMain } = require('./mocks');

let mainStateModule;
let state;
let checkRecording;

// Formats a Date the same way main-state does (local YYYY-MM-DD)
function localIsoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function makeMockEvent() {
  return {
    sender: {
      getOwnerBrowserWindow: () => ({
        webContents: { send: jest.fn() },
        show: jest.fn(),
        focus: jest.fn(),
        isDestroyed: () => false
      })
    }
  };
}

function setHolidayViaIPC(holiday) {
  const handler = mockIpcMain.on.mock.calls.find((call) => call[0] === 'updateHoliday');
  if (!handler) {
    throw new Error('updateHoliday IPC handler was never registered');
  }
  handler[1](makeMockEvent(), holiday);
}

// Builds a holiday covering the given date, for all weekdays by default
function holidayCovering(date, overrides = {}) {
  const iso = localIsoDate(date);
  return {
    label: 'Vacation',
    from: iso,
    to: iso,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startTime: '09:00',
    endTime: '17:00',
    projectId: 'project-1',
    ...overrides
  };
}

beforeAll(() => {
  resetMocks();
});

beforeEach(async () => {
  resetMocks();

  if (state) {
    try {
      if (state.stopStateValidation) state.stopStateValidation();
      if (state.cleanupOnQuit) state.cleanupOnQuit();
    } catch (e) {
      // Ignore cleanup errors
    }
    state = null;
  }

  if (mainStateModule && mainStateModule.stopStateValidation) {
    try {
      mainStateModule.stopStateValidation();
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  if (!mainStateModule) {
    mainStateModule = require('../main-state');
  }

  // Work every day, so any non-workday result is attributable to the holiday
  mockStore.set('userWorkdays', [0, 1, 2, 3, 4, 5, 6]);
  mockStore.set('userWorkhours', { start: '00:00', end: '23:59' });

  checkRecording = jest.fn();

  state = await mainStateModule.initState({
    checkRecording,
    navigateToView: jest.fn(),
    mainWindow: {
      webContents: { send: jest.fn() },
      show: jest.fn(),
      focus: jest.fn(),
      isDestroyed: () => false
    },
    overlayWindow: null
  });

  mainStateModule.loadWorkSettings();
});

describe('isHoliday', () => {
  test('returns false when no holiday is configured', () => {
    setHolidayViaIPC(null);
    expect(state.isHoliday(createTestDate(1, 12, 0))).toBe(false);
  });

  test('returns true for a date inside the window on a matching weekday', () => {
    const date = createTestDate(1, 12, 0);
    setHolidayViaIPC(holidayCovering(date));
    expect(state.isHoliday(date)).toBe(true);
  });

  test('is inclusive of both the from and to boundaries', () => {
    const start = createTestDate(1, 12, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 2);
    const middle = new Date(start);
    middle.setDate(middle.getDate() + 1);

    setHolidayViaIPC({
      ...holidayCovering(start),
      from: localIsoDate(start),
      to: localIsoDate(end)
    });

    expect(state.isHoliday(start)).toBe(true);
    expect(state.isHoliday(middle)).toBe(true);
    expect(state.isHoliday(end)).toBe(true);
  });

  test('returns false for a date outside the window', () => {
    const date = createTestDate(1, 12, 0);
    const after = new Date(date);
    after.setDate(after.getDate() + 1);
    const before = new Date(date);
    before.setDate(before.getDate() - 1);

    setHolidayViaIPC(holidayCovering(date));

    expect(state.isHoliday(before)).toBe(false);
    expect(state.isHoliday(after)).toBe(false);
  });

  test('respects the weekdays subset', () => {
    const date = createTestDate(1, 12, 0); // Monday
    setHolidayViaIPC(holidayCovering(date, { weekdays: [0, 6] })); // weekend only
    expect(state.isHoliday(date)).toBe(false);
  });
});

describe('isHoliday - malformed input fails open', () => {
  const date = createTestDate(1, 12, 0);

  // Every one of these must resolve to "not on holiday" so recording continues
  const badValues = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'holiday'],
    ['an array', []],
    ['an empty object', {}],
    ['null dates', { from: null, to: null, weekdays: [1] }],
    ['a missing weekdays array', { from: '2000-01-01', to: '2999-01-01' }],
    ['weekdays not an array', { from: '2000-01-01', to: '2999-01-01', weekdays: 1 }]
  ];

  test.each(badValues)('returns false for %s', (_description, value) => {
    setHolidayViaIPC(value);
    expect(state.isHoliday(date)).toBe(false);
    expect(state.isWorkday(date)).toBe(true);
  });

  test('never writes undefined to the store', () => {
    setHolidayViaIPC(undefined);
    // electron-store throws on undefined; the handler must normalize to null
    expect(mockStore.get('userHoliday')).toBeNull();
  });
});

describe('holiday overrides workdays', () => {
  test('a configured workday becomes a non-workday during a holiday', () => {
    const date = createTestDate(1, 12, 0);

    expect(state.isWorkday(date)).toBe(true);

    setHolidayViaIPC(holidayCovering(date));
    expect(state.isWorkday(date)).toBe(false);
  });

  test('an active work period becomes inactive during a holiday', () => {
    const date = createTestDate(1, 12, 0);

    expect(state.isActiveWorkPeriod(date)).toBe(true);

    setHolidayViaIPC(holidayCovering(date));
    expect(state.isActiveWorkPeriod(date)).toBe(false);
  });

  test('clearing the holiday restores the workday', () => {
    const date = createTestDate(1, 12, 0);

    setHolidayViaIPC(holidayCovering(date));
    expect(state.isWorkday(date)).toBe(false);

    setHolidayViaIPC(null);
    expect(state.isWorkday(date)).toBe(true);
  });

  test('a holiday does not turn a non-workday into a workday', () => {
    const date = createTestDate(1, 12, 0);
    mockStore.set('userWorkdays', []); // no workdays at all
    mainStateModule.loadWorkSettings();

    setHolidayViaIPC(holidayCovering(date));
    expect(state.isWorkday(date)).toBe(false);
  });
});

describe('holiday persistence', () => {
  test('is restored from the store on load', () => {
    const date = createTestDate(1, 12, 0);
    mockStore.set('userHoliday', holidayCovering(date));

    mainStateModule.loadWorkSettings();

    expect(state.isHoliday(date)).toBe(true);
  });

  test('an expired stored holiday no longer applies', () => {
    const date = createTestDate(1, 12, 0);
    mockStore.set('userHoliday', {
      ...holidayCovering(date),
      from: '2000-01-01',
      to: '2000-01-31'
    });

    mainStateModule.loadWorkSettings();

    expect(state.isHoliday(date)).toBe(false);
    expect(state.isWorkday(date)).toBe(true);
  });
});

describe('pause timeout during a long holiday', () => {
  // A holiday longer than the 7-day lookahead makes _findNextWorkday give up,
  // so pauseUntilNextWorkPeriod falls back to a flat 24h pause. That pause
  // expires mid-holiday, when recording must NOT resume.
  //
  // These tests assert on the recording callback rather than on isPaused(),
  // because a resume mid-holiday is transient: the 60s heartbeat re-pauses
  // shortly after, so the end state looks identical either way. Clearing the
  // pause is what lets recording start, so that is what is checked.

  const clearPauseCalls = () =>
    checkRecording.mock.calls.filter((call) => call[0] === 'clear-pause');

  function longHolidayFrom(date, days) {
    const end = new Date(date);
    end.setDate(end.getDate() + days);
    return {
      label: 'Vacation',
      from: localIsoDate(date),
      to: localIsoDate(end),
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startTime: '09:00',
      endTime: '17:00',
      projectId: 'project-1'
    };
  }

  test('does not resume when the 24h fallback expires mid-holiday', () => {
    jest.useFakeTimers();
    try {
      setHolidayViaIPC(longHolidayFrom(new Date(), 14));
      mainStateModule.stopStateValidation();

      state.pauseUntilNextWorkPeriod(null, true);
      expect(state.isPaused()).toBe(true);

      checkRecording.mockClear();

      // Advance two days, not one: the work-period-end check fires at the
      // holiday's end time and re-pauses, pushing the fallback's expiry past
      // the 24h mark. A 24h window would end before any pause ever expires.
      jest.advanceTimersByTime(48 * 60 * 60 * 1000);

      expect(state.isActiveWorkPeriod(new Date())).toBe(false);
      expect(clearPauseCalls()).toHaveLength(0);
      expect(state.isPaused()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a manual timed pause still resumes during a holiday', () => {
    jest.useFakeTimers();
    try {
      setHolidayViaIPC(longHolidayFrom(new Date(), 14));
      mainStateModule.stopStateValidation();

      // Tray pauses pass no reason, and must keep their resume-on-expiry
      // behaviour so a manual "pause 15 min" is not turned into a full stop.
      state.pauseRecording(15 * 60 * 1000, null);
      expect(state.isPaused()).toBe(true);

      checkRecording.mockClear();

      jest.advanceTimersByTime(15 * 60 * 1000 + 1000);

      expect(clearPauseCalls()).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
