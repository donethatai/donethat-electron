/**
 * @jest-environment ./src-main/__tests__/timezone-environment.js
 * @timezone Europe/Berlin
 */
const { useDstHarness } = require('./dst-harness');

const { setDayEndTime, pauseEndAfterFinishDayAt } = useDstHarness();

test('runs in Berlin time', () => {
  expect(new Date('2026-01-15T12:00:00Z').getTimezoneOffset()).toBe(-60);
});

describe('spring forward Mar 29 2026, 02:00 -> 03:00', () => {
  test('a day end in the skipped hour snaps to the change, and the next day keeps 02:30', () => {
    setDayEndTime('02:30');
    // Mar 28 18:00 CET -> Mar 29 03:00 CEST
    expect(pauseEndAfterFinishDayAt('2026-03-28T17:00:00Z')).toBe('2026-03-29T01:00:00.000Z');
    // Mar 29 18:00 CEST -> Mar 30 02:30 CEST
    expect(pauseEndAfterFinishDayAt('2026-03-29T16:00:00Z')).toBe('2026-03-30T00:30:00.000Z');
  });

  test('02:00 day end on the change day snaps to 03:00', () => {
    setDayEndTime('02:00');
    // Mar 28 18:00 CET -> Mar 29 03:00 CEST
    expect(pauseEndAfterFinishDayAt('2026-03-28T17:00:00Z')).toBe('2026-03-29T01:00:00.000Z');
  });

  test('the default 03:00 day end is unaffected', () => {
    // Mar 28 18:00 CET -> Mar 29 03:00 CEST; Mar 29 00:21 CET -> Mar 29 03:00 CEST
    expect(pauseEndAfterFinishDayAt('2026-03-28T17:00:00Z')).toBe('2026-03-29T01:00:00.000Z');
    expect(pauseEndAfterFinishDayAt('2026-03-28T23:21:00Z')).toBe('2026-03-29T01:00:00.000Z');
  });
});
