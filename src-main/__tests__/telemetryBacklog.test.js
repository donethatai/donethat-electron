const fs = require('fs')
const os = require('os')
const path = require('path')

// Prefixed with `mock` so jest allows the factory to close over it.
let mockUserDataDir

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => mockUserDataDir),
    getVersion: jest.fn(() => '2.3.3')
  }
}))

const BACKLOG_FILE = 'telemetry-backlog.json'

/** Each require() of the module is a fresh "process" sharing the same userData. */
function loadTelemetryModule() {
  let mod
  jest.isolateModules(() => {
    mod = require('../telemetry')
  })
  return mod
}

function readBacklog() {
  return JSON.parse(fs.readFileSync(path.join(mockUserDataDir, BACKLOG_FILE), 'utf8'))
}

beforeEach(() => {
  mockUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-telemetry-'))
})

afterEach(() => {
  fs.rmSync(mockUserDataDir, { recursive: true, force: true })
})

describe('telemetry backlog persistence', () => {
  test('an unflushed session leaves its queue and tail on disk', () => {
    const t = loadTelemetryModule()

    t.beginCycle({ captureIntervalMin: 5 })
    t.recordSignal('capture_cycle_phases_end', { sendMs: 800 })
    t.endCycle({ status: 'success' })

    // Logs after the last cycle closed - the window that used to vanish.
    t.recordSignal('recording_adjust_called', { source: 'power-lock', changedState: 'true' })

    t.flushTelemetryForShutdown()

    const saved = readBacklog()
    expect(saved.queue).toHaveLength(1)
    expect(saved.queue[0].cycleId).toBe(1)
    const tailMessages = saved.tailLogs.map((entry) => entry.message)
    expect(tailMessages).toContain('signal:recording_adjust_called')
  })

  test('the next session ships the previous one\'s cycles and tail', () => {
    const first = loadTelemetryModule()
    first.beginCycle({ captureIntervalMin: 5 })
    first.endCycle({ status: 'success' })
    first.beginCycle({ captureIntervalMin: 5 })
    first.endCycle({ status: 'send_failed' })
    first.recordSignal('recording_adjust_called', { source: 'power-lock' })
    first.flushTelemetryForShutdown()

    const second = loadTelemetryModule()
    const recovered = second.restorePersistedTelemetry()

    expect(recovered.restored).toBe(3) // two cycles + the session tail
    expect(recovered.cleanShutdown).toBe(true)

    const drained = []
    for (let i = 0; i < 3; i += 1) drained.push(second.consumeCompletedCycleTelemetry())

    expect(drained.map((r) => r.cycleId)).toEqual([1, 2, null])
    expect(drained[2].kind).toBe('session-tail')
    expect(drained[2].logs.map((l) => l.message)).toContain('signal:recording_adjust_called')
    drained.forEach((record) => {
      expect(record.previousSession.cleanShutdown).toBe(true)
    })
  })

  test('a killed process is distinguishable from a clean quit', () => {
    const killed = loadTelemetryModule()
    killed.beginCycle({ captureIntervalMin: 5 })
    killed.endCycle({ status: 'success' })
    // No flushTelemetryForShutdown(): stand in for a crash. Force the write the
    // coalescing timer would otherwise have done a minute later.
    killed.__test__.writeBacklogSync(false)

    const next = loadTelemetryModule()
    const recovered = next.restorePersistedTelemetry()

    expect(recovered.restored).toBeGreaterThan(0)
    expect(recovered.cleanShutdown).toBe(false)
    expect(next.consumeCompletedCycleTelemetry().previousSession.cleanShutdown).toBe(false)
  })

  test('recovery is announced in the new session\'s own logs', () => {
    const first = loadTelemetryModule()
    first.beginCycle({ captureIntervalMin: 5 })
    first.endCycle({ status: 'success' })
    first.flushTelemetryForShutdown()

    const second = loadTelemetryModule()
    second.restorePersistedTelemetry()
    second.beginCycle({ captureIntervalMin: 5 })
    const telemetry = second.endCycle({ status: 'success' })

    const restoreSignal = telemetry.logs.find((l) => l.message === 'signal:telemetry_backlog_restored')
    expect(restoreSignal).toBeDefined()
    expect(restoreSignal.meta.previousCleanShutdown).toBe('1')
  })

  test('the backlog file is consumed once, not replayed forever', () => {
    const first = loadTelemetryModule()
    first.beginCycle({ captureIntervalMin: 5 })
    first.endCycle({ status: 'success' })
    first.flushTelemetryForShutdown()

    const second = loadTelemetryModule()
    expect(second.restorePersistedTelemetry().restored).toBeGreaterThan(0)

    const third = loadTelemetryModule()
    expect(third.restorePersistedTelemetry().restored).toBe(0)
  })

  test('only the tail of a long session is carried over', () => {
    const first = loadTelemetryModule()
    for (let i = 0; i < 20; i += 1) {
      first.beginCycle({ captureIntervalMin: 5 })
      first.endCycle({ status: 'success' })
    }
    first.flushTelemetryForShutdown()

    const second = loadTelemetryModule()
    second.restorePersistedTelemetry()

    const cycleIds = []
    let record = second.consumeCompletedCycleTelemetry()
    while (record) {
      cycleIds.push(record.cycleId)
      record = second.consumeCompletedCycleTelemetry()
    }
    // The most recent 8 cycles, then the tail holding whatever happened after
    // cycle 20 closed.
    expect(cycleIds).toEqual([13, 14, 15, 16, 17, 18, 19, 20, null])
  })

  test('corrupt backlog is ignored rather than thrown', () => {
    fs.writeFileSync(path.join(mockUserDataDir, BACKLOG_FILE), '{not json')
    const t = loadTelemetryModule()
    expect(() => t.restorePersistedTelemetry()).not.toThrow()
    expect(t.restorePersistedTelemetry().restored).toBe(0)
  })

  test('a timed write before shutdown still leaves the clean snapshot published', () => {
    const t = loadTelemetryModule()
    t.beginCycle({ captureIntervalMin: 5 })
    t.endCycle({ status: 'success' })

    t.__test__.writeBacklogTimed()
    t.flushTelemetryForShutdown()

    expect(() => readBacklog()).not.toThrow()
    expect(readBacklog().cleanShutdown).toBe(true)

    const next = loadTelemetryModule()
    expect(next.restorePersistedTelemetry().cleanShutdown).toBe(true)
  })

  test('publication never goes through an async rename that could outlive shutdown', () => {
    const t = loadTelemetryModule()
    t.beginCycle({ captureIntervalMin: 5 })
    t.endCycle({ status: 'success' })

    // An async rename can still be queued when before-quit runs, land after the
    // shutdown snapshot and replace it with an older one. Publication must not
    // use one at all.
    const rename = jest.spyOn(fs.promises, 'rename')
    const writeFile = jest.spyOn(fs.promises, 'writeFile')
    try {
      t.__test__.writeBacklogTimed()
      t.flushTelemetryForShutdown()
      expect(rename).not.toHaveBeenCalled()
      expect(writeFile).not.toHaveBeenCalled()
    } finally {
      rename.mockRestore()
      writeFile.mockRestore()
    }
  })

  test('a timed write and a shutdown flush never target the same scratch file', () => {
    const t = loadTelemetryModule()
    t.beginCycle({ captureIntervalMin: 5 })
    t.endCycle({ status: 'success' })

    // Sharing one scratch path let the two writes interleave, and a rename
    // mid-write published the mixture. Assert the paths are disjoint rather
    // than trying to lose a race on purpose.
    const asyncPaths = []
    const syncPaths = []
    const realWriteFile = fs.promises.writeFile
    const realWriteFileSync = fs.writeFileSync
    jest.spyOn(fs.promises, 'writeFile').mockImplementation((file, data) => {
      asyncPaths.push(file)
      return realWriteFile.call(fs.promises, file, data)
    })
    jest.spyOn(fs, 'writeFileSync').mockImplementation((file, data) => {
      syncPaths.push(file)
      return realWriteFileSync.call(fs, file, data)
    })

    try {
      t.__test__.writeBacklogTimed()
      t.flushTelemetryForShutdown()

      expect(asyncPaths).toHaveLength(0)
      expect(syncPaths).toHaveLength(2)
      expect(syncPaths[0]).not.toEqual(syncPaths[1])
    } finally {
      fs.promises.writeFile = realWriteFile
      fs.writeFileSync = realWriteFileSync
    }

    expect(() => readBacklog()).not.toThrow()
    expect(readBacklog().cleanShutdown).toBe(true)
    expect(fs.readdirSync(mockUserDataDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('a session with nothing to report leaves nothing to restore', () => {
    const first = loadTelemetryModule()
    first.flushTelemetryForShutdown()

    const second = loadTelemetryModule()
    const recovered = second.restorePersistedTelemetry()
    // The shutdown signal itself is a tail log, so it comes back as one record.
    expect(recovered.restored).toBe(1)
    expect(second.consumeCompletedCycleTelemetry().kind).toBe('session-tail')
  })
})
