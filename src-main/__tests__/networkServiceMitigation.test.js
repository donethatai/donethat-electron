const { EventEmitter } = require('events')
const {
  ENABLED_UNTIL_STORE_KEY,
  IN_PROCESS_FEATURE,
  LOAD_TIMEOUT_MS,
  MITIGATION_DURATION_MS,
  PENDING_REPORT_STORE_KEY,
  RELAUNCH_ARG,
  applyStartupNetworkServiceMitigation,
  buildRelaunchOptions,
  createMainWindowLoadWatchdog
} = require('../networkServiceMitigation')

function createMockStore(initial = {}) {
  const values = { ...initial }
  return {
    values,
    get: jest.fn(key => values[key]),
    set: jest.fn((key, value) => {
      values[key] = value
    }),
    delete: jest.fn(key => {
      delete values[key]
    })
  }
}

function createMockApp() {
  const app = new EventEmitter()
  app.commandLine = { appendSwitch: jest.fn() }
  app.getAppMetrics = jest.fn(() => [{ type: 'Browser' }, { type: 'Utility', serviceName: 'network.mojom.NetworkService' }])
  app.relaunch = jest.fn()
  app.exit = jest.fn()
  return app
}

function createWatchdog({ app = createMockApp(), store = createMockStore(), alreadyMitigated = false, platform = 'linux', env = {}, beforeRelaunch } = {}) {
  const timers = []
  const reportToSentry = jest.fn()
  const recordSignal = jest.fn()
  const watchdog = createMainWindowLoadWatchdog({
    app,
    getStore: () => store,
    log: { warn: jest.fn(), info: jest.fn() },
    recordSignal,
    reportToSentry,
    platform,
    argv: ['/tmp/.mount_x/donethat', '--flag'],
    env,
    alreadyMitigated,
    beforeRelaunch,
    now: () => 5000,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => {
      timer.cleared = true
    }
  })
  return { app, store, timers, reportToSentry, recordSignal, watchdog }
}

describe('network service mitigation at startup', () => {
  test('runs the network service in-process on Linux while the stored window is active', () => {
    const app = createMockApp()
    const store = createMockStore({ [ENABLED_UNTIL_STORE_KEY]: 2000 })

    const active = applyStartupNetworkServiceMitigation({ app, store, platform: 'linux', argv: [], now: 1000 })

    expect(active).toBe(true)
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-features', IN_PROCESS_FEATURE)
  })

  test('runs in-process on the relaunch even before the store is read back', () => {
    const app = createMockApp()

    const active = applyStartupNetworkServiceMitigation({ app, store: createMockStore(), platform: 'linux', argv: ['x', RELAUNCH_ARG], now: 1000 })

    expect(active).toBe(true)
  })

  test('does nothing once the stored window has expired or off Linux', () => {
    const store = createMockStore({ [ENABLED_UNTIL_STORE_KEY]: 500 })
    const expiredApp = createMockApp()
    const macApp = createMockApp()

    expect(applyStartupNetworkServiceMitigation({ app: expiredApp, store, platform: 'linux', argv: [], now: 1000 })).toBe(false)
    expect(applyStartupNetworkServiceMitigation({ app: macApp, store, platform: 'darwin', argv: [RELAUNCH_ARG], now: 1000 })).toBe(false)
    expect(expiredApp.commandLine.appendSwitch).not.toHaveBeenCalled()
    expect(macApp.commandLine.appendSwitch).not.toHaveBeenCalled()
  })
})

describe('relaunch options', () => {
  test('relaunches through the AppImage file when running from one', () => {
    const options = buildRelaunchOptions(['/tmp/.mount_x/donethat', '--flag', RELAUNCH_ARG], { APPIMAGE: '/home/u/DoneThat.AppImage' })

    expect(options).toEqual({ execPath: '/home/u/DoneThat.AppImage', args: ['--flag', RELAUNCH_ARG] })
  })

  test('keeps the default executable outside an AppImage', () => {
    expect(buildRelaunchOptions(['/usr/bin/donethat'], {})).toEqual({ args: [RELAUNCH_ARG] })
  })
})

describe('main window load watchdog', () => {
  test('relaunches once with the network service in-process when the window never loads', () => {
    const { app, store, timers, reportToSentry, watchdog } = createWatchdog({ env: { APPIMAGE: '/home/u/DoneThat.AppImage' } })
    watchdog.watch(new EventEmitter())

    expect(timers[0].ms).toBe(LOAD_TIMEOUT_MS)
    timers[0].fn()

    expect(store.values[ENABLED_UNTIL_STORE_KEY]).toBe(5000 + MITIGATION_DURATION_MS)
    expect(store.values[PENDING_REPORT_STORE_KEY]).toMatchObject({ alreadyMitigated: 'false' })
    expect(reportToSentry).toHaveBeenCalledWith('Main window did not finish loading', expect.objectContaining({
      processTypes: 'Browser,network.mojom.NetworkService'
    }))
    expect(app.relaunch).toHaveBeenCalledWith({ execPath: '/home/u/DoneThat.AppImage', args: ['--flag', RELAUNCH_ARG] })
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  test('runs cleanup before relaunching', () => {
    const beforeRelaunch = jest.fn()
    const { app, timers, watchdog } = createWatchdog({ beforeRelaunch })
    watchdog.watch(new EventEmitter())

    timers[0].fn()

    expect(beforeRelaunch).toHaveBeenCalled()
    expect(beforeRelaunch.mock.invocationCallOrder[0]).toBeLessThan(app.relaunch.mock.invocationCallOrder[0])
  })

  test('reports but never relaunches again when already mitigated', () => {
    const { app, timers, reportToSentry, watchdog } = createWatchdog({ alreadyMitigated: true })
    watchdog.watch(new EventEmitter())

    timers[0].fn()

    expect(reportToSentry).toHaveBeenCalled()
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  test('stands down when the page loads in time', () => {
    const { app, timers, reportToSentry, watchdog } = createWatchdog()
    const webContents = new EventEmitter()
    watchdog.watch(webContents)

    webContents.emit('dom-ready')

    expect(timers[0].cleared).toBe(true)
    expect(reportToSentry).not.toHaveBeenCalled()
    expect(app.relaunch).not.toHaveBeenCalled()
  })

  test('stands down when the app is quitting', () => {
    const { app, timers, watchdog } = createWatchdog()
    watchdog.watch(new EventEmitter())

    app.emit('before-quit')

    expect(timers[0].cleared).toBe(true)
  })

  test('sends the stall report from the launch that recovered', () => {
    const store = createMockStore({ [PENDING_REPORT_STORE_KEY]: { waitedMs: '20000' } })
    const { reportToSentry, recordSignal, watchdog } = createWatchdog({ alreadyMitigated: true, store })
    const webContents = new EventEmitter()
    watchdog.watch(webContents)

    webContents.emit('dom-ready')

    expect(reportToSentry).toHaveBeenCalledWith('Main window loaded after network service relaunch', { waitedMs: '20000', recovered: 'true' })
    expect(recordSignal).toHaveBeenCalledWith('main-window-load-recovered', expect.any(Object))
    expect(store.values[PENDING_REPORT_STORE_KEY]).toBeUndefined()
  })

  test('does not watch off Linux', () => {
    const { timers, watchdog } = createWatchdog({ platform: 'darwin' })
    watchdog.watch(new EventEmitter())

    expect(timers).toHaveLength(0)
  })
})
