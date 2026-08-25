const {
  AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY,
  AUTO_UPDATE_DISABLE_DURATION_MS,
  AUTO_UPDATE_DISABLE_ENV,
  getAutoUpdateDisableState,
  isAutoUpdateDisabled,
  toggleAutoUpdateDisabled,
  describeAutoUpdateDisableState
} = require('../autoUpdateDisable')

function createMockStore(initial = {}) {
  const data = { ...initial }
  return {
    get: jest.fn((key) => data[key]),
    set: jest.fn((key, value) => { data[key] = value }),
    delete: jest.fn((key) => { delete data[key] })
  }
}

describe('autoUpdateDisable', () => {
  const now = 1_700_000_000_000

  test('env flag disables updates regardless of store', () => {
    const store = createMockStore()
    expect(isAutoUpdateDisabled({ store, env: { [AUTO_UPDATE_DISABLE_ENV]: '1' }, now })).toBe(true)
    expect(isAutoUpdateDisabled({ store, env: { [AUTO_UPDATE_DISABLE_ENV]: 'true' }, now })).toBe(true)
    expect(getAutoUpdateDisableState({ store, env: { [AUTO_UPDATE_DISABLE_ENV]: 'yes' }, now }).source).toBe('env')
  })

  test.each(['', '0', 'false', 'no', 'off'])('env value %j does not disable updates', (value) => {
    expect(isAutoUpdateDisabled({
      store: createMockStore(),
      env: { [AUTO_UPDATE_DISABLE_ENV]: value },
      now
    })).toBe(false)
  })

  test('future store timestamp disables updates', () => {
    const until = now + 1000
    const store = createMockStore({ [AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY]: until })
    expect(getAutoUpdateDisableState({ store, env: {}, now })).toEqual({
      disabled: true,
      until,
      source: 'store'
    })
  })

  test('expired store timestamp does not disable updates', () => {
    const store = createMockStore({ [AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY]: now - 1 })
    expect(getAutoUpdateDisableState({ store, env: {}, now })).toEqual({
      disabled: false,
      until: null,
      source: null
    })
  })

  test('toggle pauses for 7 days then clears', () => {
    const store = createMockStore()
    const paused = toggleAutoUpdateDisabled({ store, env: {}, now })
    expect(paused).toEqual({
      disabled: true,
      until: now + AUTO_UPDATE_DISABLE_DURATION_MS,
      source: 'store'
    })
    expect(store.set).toHaveBeenCalledWith(
      AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY,
      now + AUTO_UPDATE_DISABLE_DURATION_MS
    )

    const resumed = toggleAutoUpdateDisabled({ store, env: {}, now: now + 1000 })
    expect(resumed).toEqual({ disabled: false, until: null, source: null })
    expect(store.delete).toHaveBeenCalledWith(AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY)
  })

  test('toggle does not change store when env flag is set', () => {
    const store = createMockStore()
    const state = toggleAutoUpdateDisabled({
      store,
      env: { [AUTO_UPDATE_DISABLE_ENV]: '1' },
      now
    })
    expect(state.source).toBe('env')
    expect(store.set).not.toHaveBeenCalled()
    expect(store.delete).not.toHaveBeenCalled()
  })

  test('describes pause, env, and re-enable states', () => {
    expect(describeAutoUpdateDisableState({ disabled: true, source: 'env' }))
      .toBe('Auto-update is disabled by DONETHAT_DISABLE_AUTO_UPDATE.')
    expect(describeAutoUpdateDisableState({ disabled: false, until: null, source: null }))
      .toBe('Auto-update re-enabled.')
    expect(describeAutoUpdateDisableState({
      disabled: true,
      until: Date.UTC(2026, 8, 1),
      source: 'store'
    })).toMatch(/^Auto-update paused until /)
  })
})
