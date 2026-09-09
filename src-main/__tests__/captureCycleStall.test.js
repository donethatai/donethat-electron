/**
 * The in-flight guard used to be a plain boolean cleared only by the owning
 * cycle's `finally`. One cycle that never settled therefore killed capture for
 * the life of the process. These cover the deadline that releases it.
 */

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
const mockRecordSkippedOverlap = jest.fn()
const mockRecordSignal = jest.fn()
const mockBeginCycle = jest.fn()
const mockEndCycle = jest.fn(() => ({ cycleId: 1 }))

jest.mock('electron-log', () => mockLog)
jest.mock('electron', () => ({
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  powerMonitor: { getSystemIdleTime: jest.fn(() => 0), on: jest.fn() }
}))
jest.mock('../telemetry', () => ({
  beginCycle: mockBeginCycle,
  endCycle: mockEndCycle,
  consumeCompletedCycleTelemetry: jest.fn(() => null),
  requeueCompletedCycleTelemetry: jest.fn(),
  recordCyclePhaseDuration: jest.fn(),
  recordPermissionCheck: jest.fn(),
  recordCaptureCycleSkippedOverlap: mockRecordSkippedOverlap,
  recordSignal: mockRecordSignal
}))

/**
 * The guard logic lifted verbatim from `_runCaptureCycle`. Driving the real
 * function would need the whole capture stack (screenshots, audio, network,
 * fetch) stood up; the ownership rules are what these tests are about.
 */
function makeCycleRunner({ intervalMinutes = 5, now = () => Date.now() } = {}) {
  const DEADLINE_INTERVALS = 2
  const MIN_DEADLINE_MS = 10 * 60 * 1000

  let inFlight = false
  let generation = 0
  let startedAt = 0
  const completed = []

  function begin() {
    if (inFlight) {
      const stalledMs = now() - startedAt
      const deadlineMs = Math.max(DEADLINE_INTERVALS * intervalMinutes * 60 * 1000, MIN_DEADLINE_MS)
      if (stalledMs < deadlineMs) {
        mockRecordSkippedOverlap()
        return null
      }
      mockRecordSignal('capture_cycle_abandoned', { stalledSeconds: Math.round(stalledMs / 1000) })
      mockEndCycle({ status: 'abandoned' })
      inFlight = false
    }
    const cycleGeneration = ++generation
    inFlight = true
    startedAt = now()
    mockBeginCycle({ captureIntervalMin: intervalMinutes })
    return cycleGeneration
  }

  /** Stands in for the `finally` block of a cycle that finally settles. */
  function finish(cycleGeneration, status) {
    if (cycleGeneration !== generation) return 'discarded'
    completed.push(status)
    inFlight = false
    return 'recorded'
  }

  function stopCapturing() {
    generation += 1
    inFlight = false
  }

  return { begin, finish, stopCapturing, completed, isInFlight: () => inFlight }
}

beforeEach(() => jest.clearAllMocks())

describe('capture cycle stall deadline', () => {
  test('a cycle still running inside the deadline is skipped, not displaced', () => {
    let clock = 0
    const r = makeCycleRunner({ now: () => clock })

    const first = r.begin()
    clock += 4 * 60 * 1000 // one interval later, still working

    expect(r.begin()).toBeNull()
    expect(mockRecordSkippedOverlap).toHaveBeenCalledTimes(1)
    expect(mockRecordSignal).not.toHaveBeenCalledWith('capture_cycle_abandoned', expect.anything())

    // The original still owns the guard and records normally.
    expect(r.finish(first, 'success')).toBe('recorded')
    expect(r.completed).toEqual(['success'])
  })

  test('a cycle past the deadline is abandoned so the next one can run', () => {
    let clock = 0
    const r = makeCycleRunner({ now: () => clock })

    r.begin()
    clock += 17 * 60 * 1000 // the 17-minute stall seen in production

    const second = r.begin()
    expect(second).not.toBeNull()
    expect(mockRecordSignal).toHaveBeenCalledWith(
      'capture_cycle_abandoned',
      expect.objectContaining({ stalledSeconds: 1020 })
    )
    expect(mockEndCycle).toHaveBeenCalledWith({ status: 'abandoned' })
    expect(r.finish(second, 'success')).toBe('recorded')
  })

  test('an abandoned cycle finishing late cannot clear the new cycle\'s guard', () => {
    let clock = 0
    const r = makeCycleRunner({ now: () => clock })

    const stalled = r.begin()
    clock += 20 * 60 * 1000
    const fresh = r.begin()

    // The stalled cycle's send finally returns, long after it was disowned.
    expect(r.finish(stalled, 'success')).toBe('discarded')
    expect(r.isInFlight()).toBe(true) // the fresh cycle still owns the guard
    expect(r.completed).toEqual([])

    expect(r.finish(fresh, 'success')).toBe('recorded')
    expect(r.completed).toEqual(['success'])
  })

  test('capture keeps running after repeated stalls instead of dying once', () => {
    let clock = 0
    const r = makeCycleRunner({ now: () => clock })
    const started = []

    // Every cycle stalls and never settles. Before the deadline this sequence
    // produced exactly one cycle and then silence.
    for (let i = 0; i < 5; i += 1) {
      const g = r.begin()
      if (g !== null) started.push(g)
      clock += 20 * 60 * 1000
    }

    expect(started).toHaveLength(5)
  })

  test('stopping capture disowns an in-flight cycle', () => {
    let clock = 0
    const r = makeCycleRunner({ now: () => clock })

    const running = r.begin()
    r.stopCapturing()

    expect(r.isInFlight()).toBe(false)
    expect(r.finish(running, 'success')).toBe('discarded')
    expect(r.isInFlight()).toBe(false) // not resurrected by the late finish
  })

  test('the deadline never drops below ten minutes on short intervals', () => {
    let clock = 0
    const r = makeCycleRunner({ intervalMinutes: 1, now: () => clock })

    r.begin()
    clock += 9 * 60 * 1000 // past 2x interval, still inside the floor
    expect(r.begin()).toBeNull()

    clock += 2 * 60 * 1000
    expect(r.begin()).not.toBeNull()
  })
})
