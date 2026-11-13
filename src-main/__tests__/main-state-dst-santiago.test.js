/**
 * @jest-environment ./src-main/__tests__/timezone-environment.js
 * @timezone America/Santiago
 */
const { useDstHarness } = require('./dst-harness');

const { setDayEndTime, pauseEndAfterFinishDayAt } = useDstHarness();

test('runs in Santiago time', () => {
  expect(new Date('2026-07-15T12:00:00Z').getTimezoneOffset()).toBe(240);
});

describe('spring forward Sep 6 2026, 00:00 -> 01:00', () => {
  test('a midnight day end that does not exist snaps to the change (01:00)', () => {
    setDayEndTime('00:00');
    // Sep 5 18:00 -04 -> Sep 6 01:00 -03
    expect(pauseEndAfterFinishDayAt('2026-09-05T22:00:00Z')).toBe('2026-09-06T04:00:00.000Z');
  });

  test('the day after the change keeps midnight', () => {
    setDayEndTime('00:00');
    // Sep 6 18:00 -03 -> Sep 7 00:00 -03
    expect(pauseEndAfterFinishDayAt('2026-09-06T21:00:00Z')).toBe('2026-09-07T03:00:00.000Z');
  });
});
