const { formatSummaryHeadline } = require('../../src/summary-headline');

// Local-time helper: month is 1-based for readability.
function local(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('formatSummaryHeadline', () => {
  test('a normal day shows Today and the time the summary covers up to', () => {
    const now = local(2026, 11, 11, 17, 31);
    expect(formatSummaryHeadline({
      logicalDate: '2026-11-11',
      periodEnd: local(2026, 11, 11, 17, 30).getTime(),
      now
    })).toBe('Today 17:30');
  });

  test('finishing after midnight names the day that was finished, not today', () => {
    const now = local(2026, 11, 12, 0, 21);
    expect(formatSummaryHeadline({
      logicalDate: '2026-11-11',
      periodEnd: local(2026, 11, 12, 0, 20).getTime(),
      now
    })).toBe('Yesterday');
  });

  test('an older day shows its date', () => {
    const now = local(2026, 11, 12, 9, 0);
    expect(formatSummaryHeadline({
      logicalDate: '2026-11-09',
      periodEnd: local(2026, 11, 9, 18, 0).getTime(),
      now
    })).toBe('Nov 9th 18:00');
  });

  test('ordinal suffixes', () => {
    const now = local(2026, 11, 30, 12, 0);
    const label = (day) => formatSummaryHeadline({
      logicalDate: `2026-11-${String(day).padStart(2, '0')}`,
      periodEnd: local(2026, 11, day, 18, 0).getTime(),
      now
    });
    expect(label(1)).toBe('Nov 1st 18:00');
    expect(label(2)).toBe('Nov 2nd 18:00');
    expect(label(3)).toBe('Nov 3rd 18:00');
    expect(label(11)).toBe('Nov 11th 18:00');
    expect(label(12)).toBe('Nov 12th 18:00');
    expect(label(13)).toBe('Nov 13th 18:00');
    expect(label(21)).toBe('Nov 21st 18:00');
  });

  test('without a logicalDate it falls back to the period end (older servers)', () => {
    const now = local(2026, 11, 12, 0, 21);
    expect(formatSummaryHeadline({
      periodEnd: local(2026, 11, 12, 0, 20).getTime(),
      now
    })).toBe('Today 00:20');
  });

  test('a malformed logicalDate falls back to the period end', () => {
    const now = local(2026, 11, 11, 17, 31);
    expect(formatSummaryHeadline({
      logicalDate: 'not-a-date',
      periodEnd: local(2026, 11, 11, 17, 30).getTime(),
      now
    })).toBe('Today 17:30');
  });

  test('with nothing to go on it says Today', () => {
    expect(formatSummaryHeadline({ now: local(2026, 11, 11, 12, 0) })).toBe('Today');
  });
});
