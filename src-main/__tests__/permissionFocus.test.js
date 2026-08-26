const mockAppListeners = new Set()

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('electron', () => ({
  app: {
    on: (event, fn) => {
      if (event === 'browser-window-focus') mockAppListeners.add(fn)
    },
    removeListener: (event, fn) => {
      if (event === 'browser-window-focus') mockAppListeners.delete(fn)
    }
  }
}))

const log = require('electron-log')
const {
  watchForPermissionReturn,
  cancelPermissionReturnWatch,
  __test__
} = require('../permissionFocus')

/** Minimal stand-in for the BrowserWindow surface the module touches. */
function makeWindow() {
  const closedHandlers = []
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    once(event, fn) {
      if (event === 'closed') closedHandlers.push(fn)
    },
    removeListener(event, fn) {
      if (event === 'closed') {
        const i = closedHandlers.indexOf(fn)
        if (i >= 0) closedHandlers.splice(i, 1)
      }
    },
    close() {
      for (const fn of [...closedHandlers]) fn()
    }
  }
}

/** Any window gaining focus — the overlay, the tray popover, or main. */
async function focusAnyWindow() {
  for (const fn of [...mockAppListeners]) await fn()
}

beforeEach(() => {
  jest.useFakeTimers()
  mockAppListeners.clear()
  __test__.activeWatchers.clear()
  log.error.mockClear()
})

afterEach(() => {
  jest.useRealTimers()
})

it('rechecks when any window regains focus, not just the main one', async () => {
  const onReturn = jest.fn(() => true)

  watchForPermissionReturn('screen', makeWindow(), onReturn)
  await focusAnyWindow()

  expect(onReturn).toHaveBeenCalledTimes(1)
})

it('stops once the recheck reports the permission settled', async () => {
  const onReturn = jest.fn(() => true)

  watchForPermissionReturn('screen', makeWindow(), onReturn)
  await focusAnyWindow()
  await focusAnyWindow()

  expect(onReturn).toHaveBeenCalledTimes(1)
  expect(__test__.activeWatchers.size).toBe(0)
})

it('re-arms while the permission is still not granted', async () => {
  // The overlay taking focus is not the user returning from Settings. Burning
  // the watch on it used to leave the real return with nothing listening.
  const onReturn = jest.fn(() => false)

  watchForPermissionReturn('screen', makeWindow(), onReturn)
  await focusAnyWindow()
  await focusAnyWindow()

  expect(onReturn).toHaveBeenCalledTimes(2)
  expect(__test__.activeWatchers.size).toBe(1)
})

it('settles on a later focus once the grant finally lands', async () => {
  const onReturn = jest.fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)

  watchForPermissionReturn('screen', makeWindow(), onReturn)
  await focusAnyWindow()
  await focusAnyWindow()
  await focusAnyWindow()

  expect(onReturn).toHaveBeenCalledTimes(2)
  expect(__test__.activeWatchers.size).toBe(0)
})

it('does not start a second probe while one is still running', async () => {
  let release
  const onReturn = jest.fn(() => new Promise((resolve) => { release = resolve }))

  watchForPermissionReturn('screen', makeWindow(), onReturn)
  const first = focusAnyWindow()
  await focusAnyWindow()

  expect(onReturn).toHaveBeenCalledTimes(1)

  release(true)
  await first
})

it('replaces a pending watch for the same permission instead of stacking', async () => {
  const window = makeWindow()
  const first = jest.fn(() => true)
  const second = jest.fn(() => true)

  watchForPermissionReturn('screen', window, first)
  watchForPermissionReturn('screen', window, second)
  await focusAnyWindow()

  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
})

it('keeps watches for different permissions independent', async () => {
  const window = makeWindow()
  const screen = jest.fn(() => true)
  const microphone = jest.fn(() => true)

  watchForPermissionReturn('screen', window, screen)
  watchForPermissionReturn('microphone', window, microphone)
  await focusAnyWindow()

  expect(screen).toHaveBeenCalledTimes(1)
  expect(microphone).toHaveBeenCalledTimes(1)
})

it('drops the listener after the timeout so it does not outlive the session', async () => {
  const onReturn = jest.fn(() => false)

  watchForPermissionReturn('screen', makeWindow(), onReturn, { timeoutMs: 1000 })
  jest.advanceTimersByTime(1000)

  expect(mockAppListeners.size).toBe(0)
  expect(__test__.activeWatchers.size).toBe(0)

  await focusAnyWindow()
  expect(onReturn).not.toHaveBeenCalled()
})

it('disposes when the window closes', () => {
  const window = makeWindow()

  watchForPermissionReturn('screen', window, jest.fn(() => false))
  window.close()

  expect(__test__.activeWatchers.size).toBe(0)
  expect(mockAppListeners.size).toBe(0)
})

it('cancels without running the recheck', async () => {
  const onReturn = jest.fn(() => true)

  watchForPermissionReturn('screen', makeWindow(), onReturn)
  cancelPermissionReturnWatch('screen')
  await focusAnyWindow()

  expect(onReturn).not.toHaveBeenCalled()
})

it('keeps the watch armed when a recheck throws', async () => {
  const onReturn = jest.fn(() => Promise.reject(new Error('probe exploded')))

  watchForPermissionReturn('screen', makeWindow(), onReturn)
  await focusAnyWindow()

  expect(log.error).toHaveBeenCalled()
  expect(__test__.activeWatchers.size).toBe(1)
})

it('is a no-op on a destroyed window', () => {
  const window = makeWindow()
  window.destroyed = true

  watchForPermissionReturn('screen', window, jest.fn())

  expect(__test__.activeWatchers.size).toBe(0)
  expect(mockAppListeners.size).toBe(0)
})
