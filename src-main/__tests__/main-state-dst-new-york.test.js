/**
 * @jest-environment ./src-main/__tests__/timezone-environment.js
 * @timezone America/New_York
 */
const { useDstHarness } = require('./dst-harness');

const { setDayEndTime, pauseEndAfterFinishDayAt } = useDstHarness();

test('runs in New York time', () => {
  expect(new Date('2026-01-15T12:00:00Z').getTimezoneOffset()).toBe(300);
});

describe('spring forward Mar 8 2026, 02:00 -> 03:00', () => {
  test('the day after the change keeps the configured 02:30', () => {
    setDayEndTime('02:30');
    // Mar 8 18:00 EDT -> Mar 9 02:30 EDT
    expect(pauseEndAfterFinishDayAt('2026-03-08T22:00:00Z')).toBe('2026-03-09T06:30:00.000Z');
  });

  test('a day end in the skipped hour snaps to the change (03:00), like the server', () => {
    setDayEndTime('02:30');
    // Mar 7 18:00 EST -> Mar 8 03:00 EDT
    expect(pauseEndAfterFinishDayAt('2026-03-07T23:00:00Z')).toBe('2026-03-08T07:00:00.000Z');
    // Mar 8 01:00 EST, before the change -> Mar 8 03:00 EDT
    expect(pauseEndAfterFinishDayAt('2026-03-08T06:00:00Z')).toBe('2026-03-08T07:00:00.000Z');
  });

  test('the default 03:00 day end is unaffected', () => {
    // Mar 7 18:00 EST -> Mar 8 03:00 EDT; Mar 8 18:00 EDT -> Mar 9 03:00 EDT
    expect(pauseEndAfterFinishDayAt('2026-03-07T23:00:00Z')).toBe('2026-03-08T07:00:00.000Z');
    expect(pauseEndAfterFinishDayAt('2026-03-08T22:00:00Z')).toBe('2026-03-09T07:00:00.000Z');
  });
});

describe('fall back Nov 1 2026, 02:00 -> 01:00', () => {
  test('a day end that occurs twice takes the earlier instant, like the server', () => {
    setDayEndTime('01:30');
    // Oct 31 18:00 EDT -> Nov 1 01:30 EDT (the first 01:30)
    expect(pauseEndAfterFinishDayAt('2026-10-31T22:00:00Z')).toBe('2026-11-01T05:30:00.000Z');
  });

  test('the day after the change keeps 01:30', () => {
    setDayEndTime('01:30');
    // Nov 1 18:00 EST -> Nov 2 01:30 EST
    expect(pauseEndAfterFinishDayAt('2026-11-01T23:00:00Z')).toBe('2026-11-02T06:30:00.000Z');
  });
});
