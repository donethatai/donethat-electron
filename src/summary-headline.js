// Headline for the Finish day summary: the day it covers, plus the time it
// runs up to when that time falls on that day. Pure so it can be unit tested.
//
// The day comes from the server's `logicalDate`, not the period end: finishing
// at 00:21 summarizes the previous day, which must not read as "Today 00:20".

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE_REGEX.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Reject roll-overs such as 2026-02-31.
  if (date.getMonth() !== Number(match[2]) - 1) return null;
  return date;
}

function startOfDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function dayLabel(date, now) {
  const day = startOfDay(date).getTime();
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (day === today.getTime()) return 'Today';
  if (day === yesterday.getTime()) return 'Yesterday';

  const dayOfMonth = date.getDate();
  const month = date.toLocaleString('en-US', { month: 'short' });
  let suffix = 'th';
  if (dayOfMonth % 10 === 1 && dayOfMonth !== 11) suffix = 'st';
  if (dayOfMonth % 10 === 2 && dayOfMonth !== 12) suffix = 'nd';
  if (dayOfMonth % 10 === 3 && dayOfMonth !== 13) suffix = 'rd';
  return `${month} ${dayOfMonth}${suffix}`;
}

function timeLabel(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: false
  });
}

/**
 * @param {Object} params
 * @param {string} [params.logicalDate] - Day the summary covers, "YYYY-MM-DD"
 * @param {number} [params.periodEnd] - End of the summarized period, epoch ms
 * @param {Date} [params.now] - Current time
 * @returns {string}
 */
function formatSummaryHeadline({ logicalDate, periodEnd, now = new Date() } = {}) {
  const end = periodEnd ? new Date(periodEnd) : null;
  const day = parseIsoDate(logicalDate);

  if (!day) {
    // Older servers send no logicalDate: label from the period end as before.
    return end ? `${dayLabel(end, now)} ${timeLabel(end)}` : 'Today';
  }

  const label = dayLabel(day, now);
  if (end && startOfDay(end).getTime() === day.getTime()) {
    return `${label} ${timeLabel(end)}`;
  }
  return label;
}

module.exports = { formatSummaryHeadline };
