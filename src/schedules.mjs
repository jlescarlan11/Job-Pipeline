const DAY_MINUTES = 24 * 60;
const DAY_HOURS = 24;

export function validateMinuteIntervalSchedule(
  config,
  label = "interval schedule"
) {
  const errors = [];
  const intervalMinutes = config?.schedule_minutes;
  const offsetMinutes = config?.schedule_offset_minutes;
  if (
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > DAY_MINUTES ||
    DAY_MINUTES % intervalMinutes !== 0
  ) {
    errors.push(
      `${label} schedule_minutes must be a positive divisor of ${DAY_MINUTES}`
    );
  }
  if (
    !Number.isInteger(offsetMinutes) ||
    offsetMinutes < 0 ||
    (Number.isInteger(intervalMinutes) && offsetMinutes >= intervalMinutes)
  ) {
    errors.push(
      `${label} schedule_offset_minutes must be from 0 through schedule_minutes - 1`
    );
  }
  return errors;
}

export function minuteIntervalExecutionMinutes(
  config,
  label = "interval schedule"
) {
  const errors = validateMinuteIntervalSchedule(config, label);
  if (errors.length > 0) {
    throw new Error(`Invalid ${label}:\n- ${errors.join("\n- ")}`);
  }
  const minutes = [];
  for (
    let minute = config.schedule_offset_minutes;
    minute < DAY_MINUTES;
    minute += config.schedule_minutes
  ) {
    minutes.push(minute);
  }
  return minutes;
}

export function minuteIntervalScheduleRules(
  config,
  label = "interval schedule"
) {
  const executionMinutes = minuteIntervalExecutionMinutes(config, label);
  const hoursByMinute = new Map();
  for (const executionMinute of executionMinutes) {
    const minute = executionMinute % 60;
    const hour = Math.floor(executionMinute / 60);
    if (!hoursByMinute.has(minute)) hoursByMinute.set(minute, []);
    hoursByMinute.get(minute).push(hour);
  }
  const minutesByHours = new Map();
  for (const [minute, hours] of hoursByMinute) {
    const key = hours.join(",");
    if (!minutesByHours.has(key)) {
      minutesByHours.set(key, { hours, minutes: [] });
    }
    minutesByHours.get(key).minutes.push(minute);
  }
  return [...minutesByHours.values()]
    .map(({ hours, minutes }) => ({
      firstExecutionMinute: Math.min(
        ...executionMinutes.filter(
          (executionMinute) =>
            minutes.includes(executionMinute % 60) &&
            hours.includes(Math.floor(executionMinute / 60))
        )
      ),
      rule: {
        field: "cronExpression",
        expression: `0 ${minutes
          .sort((left, right) => left - right)
          .join(",")} ${
          hours.length === DAY_HOURS ? "*" : hours.join(",")
        } * * *`
      }
    }))
    .sort(
      (left, right) =>
        left.firstExecutionMinute - right.firstExecutionMinute
    )
    .map(({ rule }) => rule);
}
