import assert from "node:assert/strict";
import test from "node:test";
import {
  minuteIntervalExecutionMinutes,
  minuteIntervalScheduleRules,
  validateMinuteIntervalSchedule
} from "../src/schedules.mjs";

test("minute schedules cover a Manila day at exact offsets", () => {
  const config = { schedule_minutes: 240, schedule_offset_minutes: 8 };
  assert.deepEqual(validateMinuteIntervalSchedule(config, "scraper"), []);
  assert.deepEqual(minuteIntervalExecutionMinutes(config), [
    8,
    248,
    488,
    728,
    968,
    1208
  ]);
  assert.deepEqual(minuteIntervalScheduleRules(config), [
    {
      field: "cronExpression",
      expression: "0 8 0,4,8,12,16,20 * * *"
    }
  ]);
});

test("invalid interval or offset fails closed", () => {
  assert.ok(
    validateMinuteIntervalSchedule({
      schedule_minutes: 91,
      schedule_offset_minutes: 92
    }).length >= 2
  );
});
