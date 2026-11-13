jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => { throw new Error('not ready') }),
    getVersion: jest.fn(() => '2.5.4')
  }
}))

const telemetry = require('../telemetry')

test('aggregates get-windows helper runs per cycle and resets for the next one', () => {
  telemetry.beginCycle({ captureIntervalMin: 5 })
  telemetry.recordWindowHelperInFlight(1)
  telemetry.recordWindowHelperRun('active', 'ok', null, 90)
  telemetry.recordWindowHelperRun('active', 'ok', null, 110)
  telemetry.recordWindowHelperRun('active', 'timeout', null, 300)
  telemetry.recordWindowHelperInFlight(4)
  telemetry.recordWindowHelperInFlight(2)
  telemetry.recordWindowHelperRun('enum', 'error', 'screen-recording', 40)
  const cycle = telemetry.endCycle({ status: 'ok' })

  expect(cycle.counters.windowHelper).toEqual([
    { kind: 'active', outcome: 'ok', reason: 'none', count: 2, totalMs: 200, maxMs: 110 },
    { kind: 'active', outcome: 'timeout', reason: 'none', count: 1, totalMs: 300, maxMs: 300 },
    { kind: 'enum', outcome: 'error', reason: 'screen-recording', count: 1, totalMs: 40, maxMs: 40 }
  ])
  expect(cycle.counters.windowHelperPeakInFlight).toBe(4)

  telemetry.beginCycle({ captureIntervalMin: 5 })
  const next = telemetry.endCycle({ status: 'ok' })
  expect(next.counters.windowHelper).toEqual([])
  expect(next.counters.windowHelperPeakInFlight).toBe(0)
})
