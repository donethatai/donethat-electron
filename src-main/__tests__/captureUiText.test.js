const { EventEmitter } = require('events')

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}
const mockStoreData = { appExclusions: [] }
const mockIsTrusted = jest.fn(() => true)
const mockGetAppMetrics = jest.fn(() => [])

class MockPermissionDeniedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PermissionDeniedError'
  }
}

const mockXa11y = {
  App: { byPid: jest.fn() },
  PermissionDeniedError: MockPermissionDeniedError
}

jest.mock('electron-log', () => mockLog)
jest.mock('@crowecawcaw/xa11y', () => mockXa11y)
jest.mock('get-windows', () => ({ activeWindow: jest.fn(), openWindows: jest.fn() }))
jest.mock('../telemetry', () => ({
  recordPermissionCheck: jest.fn(),
  recordActiveWindowProbeTimeout: jest.fn(),
  recordWindowHelperRun: jest.fn(),
  recordWindowHelperInFlight: jest.fn()
}))
jest.mock('electron-store', () => ({
  __esModule: true,
  default: jest.fn(() => ({ get: (key) => mockStoreData[key] }))
}))
jest.mock('electron', () => ({
  systemPreferences: { isTrustedAccessibilityClient: (...args) => mockIsTrusted(...args) },
  ipcMain: { on: jest.fn() },
  shell: { openExternal: jest.fn() },
  app: {
    on: jest.fn(),
    removeListener: jest.fn(),
    getPath: () => '/tmp/test-user-data',
    getAppMetrics: (...args) => mockGetAppMetrics(...args)
  },
  screen: {
    getDisplayMatching: jest.fn(() => ({ id: 1, scaleFactor: 1 })),
    getAllDisplays: jest.fn(() => [])
  }
}))
jest.mock('../captureWindows', () => ({
  ...jest.requireActual('../captureWindows'),
  getActiveWindowSafe: jest.fn()
}))

const captureUiText = require('../captureUiText')
const captureWindows = require('../captureWindows')

const SECRET = 'hunter2-very-secret'
const originalPlatform = process.platform

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function makeSubscription() {
  const subscription = new EventEmitter()
  subscription.close = jest.fn()
  return subscription
}

function makeApp({ windowName = 'Inbox', tree, windows } = {}) {
  const window = {
    name: windowName,
    active: true,
    tree: jest.fn(async () => tree)
  }
  const subscription = makeSubscription()
  return {
    window,
    subscription,
    handle: {
      windows: jest.fn(async () => windows || [window]),
      subscribe: jest.fn(async () => subscription)
    }
  }
}

function setForeground({ pid = 4242, name = 'Mail', title = 'Inbox' } = {}) {
  captureWindows.getActiveWindowSafe.mockResolvedValue({ title, owner: { name, processId: pid } })
}

function node(role, name, value, children = []) {
  return { role, ...(name !== undefined ? { name } : {}), ...(value !== undefined ? { value } : {}), children }
}

function totalChars(payload) {
  return payload.entries.reduce((sum, entry) => sum + entry.text.length, 0)
}

function loggedText() {
  return JSON.stringify(Object.values(mockLog).flatMap((fn) => fn.mock.calls))
}

beforeEach(() => {
  jest.clearAllMocks()
  setPlatform('darwin')
  mockIsTrusted.mockReturnValue(true)
  mockGetAppMetrics.mockReturnValue([])
  mockStoreData.appExclusions = []
  captureUiText.__test__.resetState()
})

afterEach(() => {
  captureUiText.stopTracking()
  setPlatform(originalPlatform)
})

describe('extractLines', () => {
  test('keeps text field labels but never their values', () => {
    const tree = node('window', 'Login', undefined, [
      node('text_field', 'Username', 'alice'),
      node('text_field', 'Password', SECRET),
      node('static_text', 'Welcome back')
    ])

    const { lines } = captureUiText.__test__.extractLines(tree)

    expect(lines).toEqual(['Login', 'Username', 'Password', 'Welcome back'])
    expect(lines.join('\n')).not.toContain(SECRET)
    expect(lines.join('\n')).not.toContain('alice')
  })

  test.each(['text_field', 'text_area', 'combo_box', 'spin_button', 'document'])(
    'keeps the label of a %s but never its value or the text below it',
    (role) => {
      const tree = node('window', 'Compose', undefined, [
        node(role, 'Message body', SECRET, [node('static_text', undefined, `typed ${SECRET}`)]),
        node('static_text', 'Saved')
      ])

      const { lines } = captureUiText.__test__.extractLines(tree)

      expect(lines).toEqual(['Compose', 'Message body', 'Saved'])
      expect(lines.join('\n')).not.toContain(SECRET)
    }
  )

  test('keeps static text, headings, buttons and links', () => {
    const tree = node('window', 'Report', undefined, [
      node('heading', 'Q3 results'),
      node('static_text', undefined, 'Revenue grew 12%'),
      node('button', 'Export'),
      node('link', 'Open details'),
      node('table_cell', undefined, '42')
    ])

    const { lines } = captureUiText.__test__.extractLines(tree)

    expect(lines).toEqual(['Report', 'Q3 results', 'Revenue grew 12%', 'Export', 'Open details', '42'])
  })

  test('skips values of nodes flagged as password or named like one, in any role', () => {
    const tree = node('group', undefined, undefined, [
      { role: 'static_text', name: 'Notes', value: SECRET, password: true, children: [] },
      node('static_text', 'PIN', '1234'),
      node('static_text', 'Passwort bestätigen', SECRET),
      node('static_text', 'Draft', 'Quarterly report draft')
    ])

    const { lines } = captureUiText.__test__.extractLines(tree)

    expect(lines.join('\n')).not.toContain(SECRET)
    expect(lines).not.toContain('1234')
    expect(lines).toContain('Quarterly report draft')
  })

  test('splits multi-line text, collapses whitespace and drops noise roles', () => {
    const tree = node('window', 'Viewer', undefined, [
      node('static_text', 'Body', 'line one\n\n   line   two  '),
      node('scroll_bar', 'Vertical scroll bar'),
      node('separator', 'Divider')
    ])

    const { lines } = captureUiText.__test__.extractLines(tree)

    expect(lines).toEqual(['Viewer', 'Body', 'line one', 'line two'])
  })

  test('caps the text kept per node and flags truncation', () => {
    const { MAX_NODE_CHARS } = captureUiText.__test__.constants
    const { lines, truncated } = captureUiText.__test__.extractLines(node('group', undefined, undefined, [
      node('static_text', 'Label', 'y\n'.repeat(10) + 'x'.repeat(MAX_NODE_CHARS * 2)),
      node('static_text', 'z'.repeat(MAX_NODE_CHARS + 50))
    ]))

    const firstNodeChars = lines.slice(0, -1).reduce((sum, line) => sum + line.length, 0)
    expect(firstNodeChars).toBe(MAX_NODE_CHARS)
    expect(lines[lines.length - 1]).toHaveLength(MAX_NODE_CHARS)
    expect(truncated).toBe(true)
  })

  test('does not read below the depth cap', () => {
    const { SNAPSHOT_MAX_DEPTH } = captureUiText.__test__.constants
    let tree = node('static_text', 'too deep')
    for (let depth = 0; depth <= SNAPSHOT_MAX_DEPTH; depth++) tree = node('group', undefined, undefined, [tree])

    expect(captureUiText.__test__.extractLines(tree).lines).toEqual([])
  })
})

describe('buffering', () => {
  test('dedupes identical lines per app, keeping the newest occurrence, and merges entries per window', () => {
    const { addSnapshotToBuffer, buildPayload } = captureUiText.__test__
    addSnapshotToBuffer({ appName: 'Mail', windowTitle: 'Inbox', lines: ['Inbox', 'Hello'], truncated: false, capturedAtMs: 1 })
    addSnapshotToBuffer({ appName: 'Mail', windowTitle: 'Inbox', lines: ['Inbox', 'Hello', 'New mail'], truncated: false, capturedAtMs: 2 })
    addSnapshotToBuffer({ appName: 'Mail', windowTitle: 'Draft', lines: ['Draft', 'Subject'], truncated: false, capturedAtMs: 3 })
    addSnapshotToBuffer({ appName: 'Notes', windowTitle: 'Todo', lines: ['Hello'], truncated: false, capturedAtMs: 4 })

    expect(buildPayload()).toEqual({
      entries: [
        { app: 'Mail', windowTitle: 'Inbox', text: 'Inbox\nHello\nNew mail', capturedAtMs: 2 },
        { app: 'Mail', windowTitle: 'Draft', text: 'Draft\nSubject', capturedAtMs: 3 },
        { app: 'Notes', windowTitle: 'Todo', text: 'Hello', capturedAtMs: 4 }
      ],
      truncated: false
    })
  })

  test('caps total text at 8000 chars, keeping the most recent text', () => {
    const { addSnapshotToBuffer, buildPayload, constants } = captureUiText.__test__
    const lines = Array.from({ length: 40 }, (_, index) => `${index}`.padEnd(400, 'x'))
    addSnapshotToBuffer({ appName: 'Docs', windowTitle: 'Spec', lines, truncated: false, capturedAtMs: 1 })
    addSnapshotToBuffer({ appName: 'Mail', windowTitle: 'Inbox', lines: ['y'.repeat(500)], truncated: false, capturedAtMs: 2 })

    const payload = buildPayload()
    expect(payload.truncated).toBe(true)
    expect(totalChars(payload)).toBeLessThanOrEqual(constants.MAX_TOTAL_CHARS)
    expect(payload.entries.map((entry) => entry.app)).toEqual(['Docs', 'Mail'])
    expect(payload.entries[1].text).toBe('y'.repeat(500))
  })

  test('omits window titles, as metadata and as text lines, when asked to', () => {
    const { addSnapshotToBuffer, buildPayload } = captureUiText.__test__
    addSnapshotToBuffer({ appName: 'Browser', windowTitle: 'My Bank', titles: ['My Bank', 'My Bank - Accounts'], lines: ['My Bank', 'Balance overview'], truncated: false, capturedAtMs: 1 })
    addSnapshotToBuffer({ appName: 'Browser', windowTitle: 'News', titles: ['News'], lines: ['News', 'my bank - accounts', 'Headline'], truncated: false, capturedAtMs: 2 })

    expect(buildPayload({ includeWindowTitles: false })).toEqual({
      entries: [{ app: 'Browser', windowTitle: null, text: 'Balance overview\nHeadline', capturedAtMs: 1 }],
      truncated: false
    })
    expect(buildPayload().entries.map((entry) => entry.windowTitle)).toEqual(['My Bank', 'News'])
  })

  test('caps the number of entries', () => {
    const { addSnapshotToBuffer, buildPayload, constants } = captureUiText.__test__
    for (let index = 0; index < constants.MAX_ENTRIES + 5; index++) {
      addSnapshotToBuffer({ appName: 'Browser', windowTitle: `Tab ${index}`, lines: [`line ${index}`], truncated: false, capturedAtMs: index })
    }

    const payload = buildPayload()
    expect(payload.entries).toHaveLength(constants.MAX_ENTRIES)
    expect(payload.truncated).toBe(true)
  })

  test('returns null when nothing was captured', () => {
    expect(captureUiText.__test__.buildPayload()).toBeNull()
  })
})

describe('cycle stats', () => {
  test('counts deduplicated text before the cap and what was sent, never text', () => {
    const { addSnapshotToBuffer, buildPayload, computeCycleStats } = captureUiText.__test__
    addSnapshotToBuffer({ appName: 'Mail', windowTitle: 'Inbox', lines: ['Inbox', 'Hello'], truncated: false, capturedAtMs: 1 })
    addSnapshotToBuffer({ appName: 'Mail', windowTitle: 'Inbox', lines: ['Inbox', 'Hello', 'New mail'], truncated: false, capturedAtMs: 2 })
    addSnapshotToBuffer({ appName: 'Notes', windowTitle: 'Todo', lines: ['Hello'], truncated: false, capturedAtMs: 3 })

    const payload = buildPayload()
    const stats = computeCycleStats(payload, true)

    expect(stats).toEqual({
      uniqueChars: 'Inbox'.length + 1 + 'Hello'.length + 1 + 'New mail'.length + 1 + 'Hello'.length + 1,
      sentChars: payload.entries.reduce((sum, entry) => sum + entry.text.length, 0)
    })
  })

  test('reports text over the cap as unique chars above sent chars', () => {
    const { addSnapshotToBuffer, buildPayload, computeCycleStats, constants } = captureUiText.__test__
    const line = 'x'.repeat(250)
    for (let index = 0; index < 60; index++) {
      addSnapshotToBuffer({ appName: 'Editor', windowTitle: 'File', lines: [`${index}${line}`], truncated: false, capturedAtMs: index })
    }

    const payload = buildPayload()
    const stats = computeCycleStats(payload, true)

    expect(stats.sentChars).toBeLessThanOrEqual(constants.MAX_TOTAL_CHARS)
    expect(stats.uniqueChars).toBeGreaterThan(constants.MAX_TOTAL_CHARS)
  })
})

describe('tracking', () => {
  test('captures the focused window text at cycle end and resets the buffer', async () => {
    const fake = makeApp({
      tree: node('window', 'Inbox', undefined, [
        node('static_text', 'Quarterly planning'),
        node('text_field', 'Password', SECRET)
      ])
    })
    mockXa11y.App.byPid.mockResolvedValue(fake.handle)
    setForeground()

    await expect(captureUiText.startTracking()).resolves.toBe(true)
    const payload = await captureUiText.getUiTextBuffer(true)

    expect(mockXa11y.App.byPid).toHaveBeenCalledWith(4242, { timeout: 0 })
    expect(fake.window.tree).toHaveBeenCalledWith(captureUiText.__test__.constants.SNAPSHOT_MAX_DEPTH)
    expect(payload).toEqual({
      entries: [{ app: 'Mail', windowTitle: 'Inbox', text: 'Inbox\nQuarterly planning\nPassword', capturedAtMs: expect.any(Number) }],
      truncated: false
    })
    fake.window.tree.mockResolvedValue(node('window', 'Inbox'))
    expect((await captureUiText.getUiTextBuffer(true)).entries.map((entry) => entry.text)).toEqual(['Inbox'])
    expect(loggedText()).not.toContain(SECRET)
    expect(loggedText()).not.toContain('Quarterly planning')
  })

  test('subscribes to window activation only and releases it on app switch and stop', async () => {
    const first = makeApp({ tree: node('window', 'A') })
    const second = makeApp({ tree: node('window', 'B') })
    mockXa11y.App.byPid.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle)
    setForeground({ pid: 1001, name: 'First' })

    await captureUiText.startTracking()
    await captureUiText.__test__.pollForeground()
    expect(first.subscription.listenerCount('windowActivated')).toBe(1)
    expect(first.subscription.listenerCount('focusChanged')).toBe(0)

    setForeground({ pid: 1002, name: 'Second' })
    await captureUiText.__test__.pollForeground()
    expect(first.subscription.close).toHaveBeenCalled()
    expect(second.subscription.listenerCount('windowActivated')).toBe(1)

    captureUiText.stopTracking()
    expect(second.subscription.close).toHaveBeenCalled()
  })

  test('a window activation snapshots after the debounce; focus changes do not', async () => {
    const fake = makeApp({ tree: node('static_text', 'Focused text') })
    mockXa11y.App.byPid.mockResolvedValue(fake.handle)
    setForeground()
    const settle = () => new Promise((resolve) => setTimeout(resolve, captureUiText.__test__.constants.SNAPSHOT_DEBOUNCE_MS + 200))

    await captureUiText.startTracking()
    await captureUiText.__test__.pollForeground()
    await settle()
    const callsAfterAttach = fake.window.tree.mock.calls.length
    fake.subscription.emit('focusChanged', {})
    await settle()
    expect(fake.window.tree.mock.calls.length).toBe(callsAfterAttach)

    fake.subscription.emit('windowActivated', {})
    fake.subscription.emit('windowActivated', {})
    await settle()

    expect(fake.window.tree.mock.calls.length).toBe(callsAfterAttach + 1)
    expect(captureUiText.__test__.buildPayload().entries[0].text).toBe('Focused text')
  })

  test('never reads text from excluded apps', async () => {
    mockStoreData.appExclusions = [{ appName: 'Mail' }]
    const fake = makeApp({ tree: node('static_text', SECRET) })
    mockXa11y.App.byPid.mockResolvedValue(fake.handle)
    setForeground()

    await captureUiText.startTracking()
    const payload = await captureUiText.getUiTextBuffer(true)

    expect(payload).toBeNull()
    expect(mockXa11y.App.byPid).not.toHaveBeenCalled()
    expect(fake.window.tree).not.toHaveBeenCalled()
  })

  test('drops snapshots whose accessibility window title matches an exclusion pattern', async () => {
    mockStoreData.appExclusions = [{ appName: 'Browser', titlePatterns: ['bank'] }]
    const fake = makeApp({ windowName: 'My Bank - Accounts', tree: node('static_text', SECRET) })
    mockXa11y.App.byPid.mockResolvedValue(fake.handle)
    setForeground({ name: 'Browser', title: 'Loading' })

    await captureUiText.startTracking()

    expect(await captureUiText.getUiTextBuffer(true)).toBeNull()
  })

  test('skips our own process', async () => {
    setForeground({ pid: process.pid, name: 'DoneThat' })

    await captureUiText.startTracking()

    expect(await captureUiText.getUiTextBuffer(true)).toBeNull()
    expect(mockXa11y.App.byPid).not.toHaveBeenCalled()
  })

  test('enables web accessibility once per pid when the library offers it, ignoring failures', async () => {
    const fake = makeApp({ tree: node('static_text', 'Hello') })
    fake.handle.enableWebAccessibility = jest.fn(async () => { throw new Error('unsupported') })
    mockXa11y.App.byPid.mockResolvedValue(fake.handle)
    setForeground()

    await captureUiText.startTracking()
    const payload = await captureUiText.getUiTextBuffer(true)
    captureUiText.stopTracking()
    await captureUiText.startTracking()
    await captureUiText.getUiTextBuffer(true)

    expect(payload.entries[0].text).toBe('Hello')
    expect(fake.handle.enableWebAccessibility).toHaveBeenCalledTimes(1)
  })

  test('a hanging tree snapshot times out without throwing', async () => {
    const fake = makeApp()
    fake.window.tree.mockImplementation(() => new Promise(() => {}))
    mockXa11y.App.byPid.mockResolvedValue(fake.handle)
    setForeground()

    await captureUiText.startTracking()
    const startedAt = Date.now()
    const payload = await captureUiText.getUiTextBuffer(true)

    expect(payload).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(3500)
  })

  test('does not stack a second tree read on a pid whose read has timed out but not settled', async () => {
    let settleTree
    const fake = makeApp()
    fake.window.tree.mockImplementationOnce(() => new Promise((resolve) => { settleTree = resolve }))
    fake.window.tree.mockResolvedValue(node('static_text', 'Later text'))
    mockXa11y.App.byPid.mockResolvedValue(fake.handle)
    setForeground()

    await captureUiText.startTracking()
    await captureUiText.__test__.pollForeground()
    await captureUiText.__test__.snapshotFocusedWindow()
    expect(fake.window.tree).toHaveBeenCalledTimes(1)

    await captureUiText.__test__.snapshotFocusedWindow()
    expect(fake.window.tree).toHaveBeenCalledTimes(1)

    settleTree(node('static_text', 'Stale'))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, captureUiText.__test__.constants.SNAPSHOT_DEBOUNCE_MS * 2))
    await captureUiText.__test__.snapshotFocusedWindow()
    expect(fake.window.tree).toHaveBeenCalledTimes(2)
    expect(captureUiText.__test__.buildPayload().entries[0].text).toBe('Later text')
  })

  test('backoff is per pid and resets when the foreground app changes', async () => {
    const failing = makeApp()
    failing.window.tree.mockRejectedValue(new Error('read failed'))
    const healthy = makeApp({ tree: node('static_text', 'Healthy text') })
    mockXa11y.App.byPid.mockImplementation(async (pid) => (pid === 1001 ? failing.handle : healthy.handle))
    setForeground({ pid: 1001, name: 'Failing' })

    await captureUiText.startTracking()
    await captureUiText.__test__.pollForeground()
    await captureUiText.__test__.snapshotFocusedWindow()
    await captureUiText.__test__.snapshotFocusedWindow()
    expect(failing.window.tree).toHaveBeenCalledTimes(1)

    setForeground({ pid: 1002, name: 'Healthy' })
    const payload = await captureUiText.getUiTextBuffer(true)

    expect(payload.entries.map((entry) => entry.text)).toEqual(['Healthy text'])
  })

  test('library failures never throw out of collection and permission denial is reported', async () => {
    const fake = makeApp()
    fake.window.tree.mockRejectedValue(new MockPermissionDeniedError(`details ${SECRET}`))
    mockXa11y.App.byPid.mockResolvedValue(fake.handle)
    setForeground()

    await captureUiText.startTracking()
    await expect(captureUiText.getUiTextBuffer(true)).resolves.toBeNull()

    expect(captureUiText.getStatus().permissionDenied).toBe(true)
    expect(loggedText()).not.toContain(SECRET)
  })

  test('a refusal from one app stops counting once another app is read successfully', async () => {
    const refusing = makeApp()
    refusing.window.tree.mockRejectedValue(new MockPermissionDeniedError('denied'))
    const healthy = makeApp({ tree: node('static_text', 'Healthy text') })
    mockXa11y.App.byPid.mockImplementation(async (pid) => (pid === 1001 ? refusing.handle : healthy.handle))
    setForeground({ pid: 1001, name: 'Refusing' })

    await captureUiText.startTracking()
    await captureUiText.getUiTextBuffer(true)
    expect(captureUiText.getStatus().permissionDenied).toBe(true)

    setForeground({ pid: 1002, name: 'Healthy' })
    await captureUiText.getUiTextBuffer(true)

    expect(captureUiText.getStatus().permissionDenied).toBe(false)
  })

  test('reports a missing accessibility library instead of appearing on', async () => {
    jest.resetModules()
    jest.doMock('@crowecawcaw/xa11y', () => { throw Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' }) })
    const isolated = require('../captureUiText')
    const started = isolated.startTracking()
    jest.doMock('@crowecawcaw/xa11y', () => mockXa11y)

    await expect(started).resolves.toBe(false)
    expect(isolated.isTracking()).toBe(false)
    expect(isolated.getStatus()).toMatchObject({ supported: true, tracking: false, libraryUnavailable: true })
  })

  test('app lookup failure does not throw', async () => {
    mockXa11y.App.byPid.mockRejectedValue(new Error('not found'))
    setForeground()

    await captureUiText.startTracking()

    await expect(captureUiText.getUiTextBuffer(true)).resolves.toBeNull()
  })

  test('does not start on macOS without Accessibility trust and reports it', async () => {
    mockIsTrusted.mockReturnValue(false)

    await expect(captureUiText.startTracking()).resolves.toBe(false)

    expect(captureUiText.isTracking()).toBe(false)
    expect(captureUiText.getStatus()).toMatchObject({ permissionDenied: true, accessibilityTrusted: false })
    expect(mockIsTrusted).toHaveBeenCalledWith(false)
  })

  test('is a no-op on linux', async () => {
    setPlatform('linux')
    setForeground()

    expect(captureUiText.isUiTextSupported()).toBe(false)
    await expect(captureUiText.startTracking()).resolves.toBe(false)
    await expect(captureUiText.getUiTextBuffer(true)).resolves.toBeNull()
    expect(captureUiText.getStatus()).toEqual({
      supported: false,
      tracking: false,
      permissionDenied: false,
      accessibilityTrusted: true,
      libraryUnavailable: false
    })
    expect(mockXa11y.App.byPid).not.toHaveBeenCalled()
  })

  test('runs on windows without an Accessibility trust check', async () => {
    setPlatform('win32')
    const fake = makeApp({ tree: node('static_text', 'Hello') })
    mockXa11y.App.byPid.mockResolvedValue(fake.handle)
    setForeground()

    await captureUiText.startTracking()

    expect((await captureUiText.getUiTextBuffer(true)).entries[0].text).toBe('Hello')
    expect(mockIsTrusted).not.toHaveBeenCalled()
  })
})
