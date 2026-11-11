const {
  GPU_DISABLED_ARG,
  GPU_DISABLED_UNTIL_STORE_KEY,
  GPU_DISABLE_DURATION_MS,
  applyStartupGpuMitigation,
  buildRelaunchArgs,
  createGpuCrashMitigator,
  isGpuMitigationSupportedPlatform,
  isGpuProcessCrash,
  shouldDisableHardwareAcceleration
} = require('../gpuCrashMitigation')

function createMockStore(initial = {}) {
  const values = { ...initial }
  return {
    get: jest.fn(key => values[key]),
    set: jest.fn((key, value) => {
      values[key] = value
    })
  }
}

function createMockApp() {
  return {
    commandLine: {
      appendSwitch: jest.fn()
    },
    disableHardwareAcceleration: jest.fn(),
    exit: jest.fn(),
    relaunch: jest.fn()
  }
}

describe('GPU crash mitigation', () => {
  test('applies startup mitigation on supported desktop platforms when the stored disable window is active', () => {
    const now = 1000
    for (const platform of ['win32', 'darwin', 'linux']) {
      const app = createMockApp()
      const store = createMockStore({
        [GPU_DISABLED_UNTIL_STORE_KEY]: now + 1
      })

      const applied = applyStartupGpuMitigation({
        app,
        store,
        platform,
        argv: ['DoneThat'],
        now
      })

      expect(applied).toBe(true)
      expect(app.disableHardwareAcceleration).toHaveBeenCalled()
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu')
    }
  })

  test('does not apply startup mitigation on unsupported platforms', () => {
    expect(shouldDisableHardwareAcceleration({
      platform: 'freebsd',
      argv: [GPU_DISABLED_ARG],
      disabledUntil: Date.now() + 1000
    })).toBe(false)
    expect(isGpuMitigationSupportedPlatform('freebsd')).toBe(false)
  })

  test('applies startup mitigation on macOS and Linux when relaunched with the mitigation arg', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(shouldDisableHardwareAcceleration({
        platform,
        argv: [GPU_DISABLED_ARG],
        disabledUntil: 0
      })).toBe(true)
    }
  })

  test('persists a disable window when relaunched with the GPU mitigation arg', () => {
    const now = 2000
    const app = createMockApp()
    const store = createMockStore()

    const applied = applyStartupGpuMitigation({
      app,
      store,
      platform: 'linux',
      argv: ['DoneThat', GPU_DISABLED_ARG],
      now
    })

    expect(applied).toBe(true)
    expect(store.set).toHaveBeenCalledWith(
      GPU_DISABLED_UNTIL_STORE_KEY,
      now + GPU_DISABLE_DURATION_MS
    )
  })

  test('identifies GPU process crashes only for crash reasons', () => {
    expect(isGpuProcessCrash({ type: 'GPU', reason: 'crashed' })).toBe(true)
    expect(isGpuProcessCrash({ type: 'GPU', reason: 'clean-exit' })).toBe(false)
    expect(isGpuProcessCrash({ type: 'Utility', reason: 'crashed' })).toBe(false)
  })

  test('relaunches with GPU disabled after repeated GPU crashes', () => {
    let now = 1000
    const app = createMockApp()
    const staleStore = createMockStore()
    const freshStore = createMockStore()
    const getStore = jest.fn(() => freshStore)
    const recordSignal = jest.fn()
    const mitigator = createGpuCrashMitigator({
      app,
      store: staleStore,
      getStore,
      recordSignal,
      platform: 'darwin',
      argv: ['DoneThat', '--existing'],
      now: () => now
    })

    expect(mitigator.handleChildProcessGone({ type: 'GPU', reason: 'crashed' })).toBe(false)
    now += 1000
    expect(mitigator.handleChildProcessGone({ type: 'GPU', reason: 'abnormal-exit' })).toBe(true)

    expect(getStore).toHaveBeenCalledTimes(1)
    expect(staleStore.set).not.toHaveBeenCalled()
    expect(freshStore.set).toHaveBeenCalledWith(
      GPU_DISABLED_UNTIL_STORE_KEY,
      now + GPU_DISABLE_DURATION_MS
    )
    expect(recordSignal).toHaveBeenCalledWith(
      'gpu-mitigation-relaunch',
      expect.objectContaining({ gpuCrashCount: '2' })
    )
    expect(app.relaunch).toHaveBeenCalledWith({
      args: ['--existing', GPU_DISABLED_ARG]
    })
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  test('runs the cleanup hook before relaunching, even if it throws', () => {
    const order = []
    const app = createMockApp()
    app.relaunch.mockImplementation(() => order.push('relaunch'))
    app.exit.mockImplementation(() => order.push('exit'))
    const log = { warn: jest.fn() }
    const beforeRelaunch = jest.fn(() => {
      order.push('cleanup')
      throw new Error('worker gone')
    })
    const mitigator = createGpuCrashMitigator({
      app,
      store: createMockStore(),
      log,
      platform: 'win32',
      argv: ['DoneThat'],
      now: () => 1000,
      beforeRelaunch
    })

    mitigator.handleChildProcessGone({ type: 'GPU', reason: 'crashed' })
    expect(beforeRelaunch).not.toHaveBeenCalled()
    expect(mitigator.handleChildProcessGone({ type: 'GPU', reason: 'crashed' })).toBe(true)

    expect(order).toEqual(['cleanup', 'relaunch', 'exit'])
    expect(log.warn).toHaveBeenCalledWith('Cleanup before GPU mitigation relaunch failed:', 'worker gone')
  })

  test('does not relaunch when mitigation is already active', () => {
    const app = createMockApp()
    const mitigator = createGpuCrashMitigator({
      app,
      platform: 'linux',
      alreadyDisabled: true
    })

    expect(mitigator.handleChildProcessGone({ type: 'GPU', reason: 'crashed' })).toBe(false)
    expect(app.relaunch).not.toHaveBeenCalled()
  })

  test('builds relaunch args without duplicating the mitigation flag', () => {
    expect(buildRelaunchArgs(['DoneThat.exe', '--foo', GPU_DISABLED_ARG])).toEqual([
      '--foo',
      GPU_DISABLED_ARG
    ])
  })
})
