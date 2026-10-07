import assert from 'node:assert/strict';
import test from 'node:test';
import { currentScheduleWeekIndex } from '../league-api.js';

test('commissioner-released schedules use the latest announced week', () => {
  const schedule = {
    progression: 'commissioner',
    startDate: 0,
    weeks: [{ matches: [] }, { matches: [] }, { matches: [] }]
  };
  assert.equal(currentScheduleWeekIndex(schedule), 2);
});

test('legacy schedules continue to follow their calendar start date', () => {
  const schedule = {
    startDate: Date.now() - 15 * 86400000,
    weeks: [{ matches: [] }, { matches: [] }, { matches: [] }, { matches: [] }]
  };
  assert.equal(currentScheduleWeekIndex(schedule), 2);
});

test('schedules without announced weeks have no current week', () => {
  assert.equal(currentScheduleWeekIndex({ progression: 'commissioner', weeks: [] }), null);
  assert.equal(currentScheduleWeekIndex(null), null);
});
