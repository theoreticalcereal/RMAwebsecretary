const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_INDEX_FROM_CODE = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

function studioTimezone() {
  return process.env.STUDIO_TIMEZONE || "America/Chicago";
}

function partsInZone(dateInput, timezone) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || studioTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = {};
  formatter.formatToParts(date).forEach((part) => {
    if (part.type !== "literal") values[part.type] = part.value;
  });
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function dateString(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function timeString(parts) {
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function validDateParts(year, month, day, hour, minute, second = 0) {
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return check.getUTCFullYear() === year
    && check.getUTCMonth() === month - 1
    && check.getUTCDate() === day
    && check.getUTCHours() === hour
    && check.getUTCMinutes() === minute
    && check.getUTCSeconds() === second;
}

function zonedLocalToDate(dateValue, timeValue = "00:00", timezone = studioTimezone()) {
  const dateMatch = String(dateValue || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeValue || "").match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) return null;
  const [, y, mo, d] = dateMatch;
  const [, h, mi, s = "00"] = timeMatch;
  const desired = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!validDateParts(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s))) return null;

  let guess = desired;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = partsInZone(new Date(guess), timezone);
    if (!actual) return null;
    const actualWall = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const nextGuess = guess + (desired - actualWall);
    if (nextGuess === guess) break;
    guess = nextGuess;
  }
  const roundTrip = partsInZone(new Date(guess), timezone);
  if (!roundTrip || dateString(roundTrip) !== dateValue || timeString(roundTrip) !== `${h}:${mi}`) return null;
  return new Date(guess);
}

function zonedLocalToUtc(dateValue, timeValue, timezone = studioTimezone()) {
  const date = zonedLocalToDate(dateValue, timeValue, timezone);
  return date ? date.toISOString().replace(".000Z", "Z") : null;
}

function addDays(dateValue, amount) {
  const [year, month, day] = String(dateValue).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayIndex(dateValue) {
  const [year, month, day] = String(dateValue).split("-").map(Number);
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (jsDay + 6) % 7;
}

function daysBetween(startDate, endDate) {
  return Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000);
}

function startOfWeek(dateValue, weekStartCode = "MO") {
  const weekStartIndex = DAY_INDEX_FROM_CODE[weekStartCode] ?? DAY_INDEX_FROM_CODE.MO;
  const offset = (dayIndex(dateValue) - weekStartIndex + 7) % 7;
  return addDays(dateValue, -offset);
}

function countWeeklyOccurrencesBefore(baseDate, beforeDate, byDays, interval, weekStartCode) {
  if (beforeDate <= baseDate) return 0;
  const baseWeekStart = startOfWeek(baseDate, weekStartCode);
  const baseOffset = daysBetween(baseWeekStart, baseDate);
  const lastOffset = daysBetween(baseWeekStart, addDays(beforeDate, -1));
  const weekStartIndex = DAY_INDEX_FROM_CODE[weekStartCode] ?? DAY_INDEX_FROM_CODE.MO;

  return byDays.reduce((total, code) => {
    const codeIndex = DAY_INDEX_FROM_CODE[code];
    if (codeIndex === undefined) return total;
    const codeOffset = (codeIndex - weekStartIndex + 7) % 7;
    const minimumWeek = Math.max(0, Math.ceil((baseOffset - codeOffset) / 7));
    const maximumWeek = Math.floor((lastOffset - codeOffset) / 7);
    if (maximumWeek < minimumWeek) return total;
    const firstActiveWeek = minimumWeek + ((interval - (minimumWeek % interval)) % interval);
    if (firstActiveWeek > maximumWeek) return total;
    return total + Math.floor((maximumWeek - firstActiveWeek) / interval) + 1;
  }, 0);
}

function parseRule(rule) {
  const result = {};
  String(rule || "").split(";").forEach((part) => {
    const [key, value] = part.split("=");
    if (key && value) result[key.toUpperCase()] = value;
  });
  return result;
}

function parseRuleUntil(value, timezone) {
  const raw = String(value || "");
  const dateTime = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (dateTime) {
    const [, year, month, day, hour, minute, second] = dateTime;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const dateOnly = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return zonedLocalToDate(`${year}-${month}-${day}`, "23:59:59", timezone);
  }
  return null;
}

function normalizedEventDates(event, fallbackTimezone) {
  const timezone = event.timezone || fallbackTimezone || studioTimezone();
  if (event.allDay || /^\d{4}-\d{2}-\d{2}$/.test(String(event.start || ""))) {
    const startDate = String(event.start).slice(0, 10);
    const endDate = String(event.end || addDays(startDate, 1)).slice(0, 10);
    return {
      start: zonedLocalToDate(startDate, "00:00", timezone),
      end: zonedLocalToDate(endDate, "00:00", timezone),
      timezone,
      localStartDate: startDate,
      localEndDate: endDate,
      localStartTime: "00:00",
      allDay: true,
    };
  }
  const startRaw = String(event.start || "");
  const endRaw = String(event.end || "");
  const start = /Z$|[+-]\d{2}:?\d{2}$/.test(startRaw)
    ? new Date(startRaw)
    : zonedLocalToDate(startRaw.slice(0, 10), startRaw.slice(11, 16), timezone);
  const end = /Z$|[+-]\d{2}:?\d{2}$/.test(endRaw)
    ? new Date(endRaw)
    : zonedLocalToDate(endRaw.slice(0, 10), endRaw.slice(11, 16), timezone);
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const local = partsInZone(start, timezone);
  return {
    start,
    end,
    timezone,
    localStartDate: dateString(local),
    localStartTime: timeString(local),
    allDay: false,
  };
}

function expandCalendarEvents(events, options = {}) {
  const timezone = options.timezone || studioTimezone();
  const rangeStart = new Date(options.rangeStart);
  const rangeEnd = new Date(options.rangeEnd);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || rangeStart >= rangeEnd) return [];
  const occurrences = [];
  const occurrenceRecord = (event, start, end, occurrenceDate) => {
    const displayStart = partsInZone(start, timezone);
    const displayEnd = partsInZone(end, timezone);
    const firstVisibleDate = [
      dateString(displayStart),
      dateString(partsInZone(rangeStart, timezone)),
    ].sort().at(-1);
    const lastVisibleDate = [
      dateString(partsInZone(new Date(end.getTime() - 1), timezone)),
      dateString(partsInZone(new Date(rangeEnd.getTime() - 1), timezone)),
    ].sort()[0];
    const displayDates = [];
    for (let date = firstVisibleDate; date <= lastVisibleDate; date = addDays(date, 1)) {
      displayDates.push(date);
    }
    const actualStartDate = dateString(displayStart);
    const actualEndDate = dateString(displayEnd);
    const displaySegments = displayDates.map((date) => ({
      date,
      startTime: event.allDay || date !== actualStartDate ? "00:00" : timeString(displayStart),
      endTime: event.allDay ? "00:00" : (date === actualEndDate ? timeString(displayEnd) : "23:59"),
    }));
    return {
      ...event,
      occurrenceId: `${event.id || event.uid}:${occurrenceDate}`,
      start: start.toISOString().replace(".000Z", "Z"),
      end: end.toISOString().replace(".000Z", "Z"),
      date: dateString(displayStart),
      startTime: timeString(displayStart),
      endTime: timeString(displayEnd),
      displayDates,
      displaySegments,
    };
  };

  (Array.isArray(events) ? events : []).forEach((event) => {
    const normalized = normalizedEventDates(event, timezone);
    if (!normalized || normalized.start >= normalized.end) return;
    const duration = normalized.end.getTime() - normalized.start.getTime();
    const rule = parseRule(event.recurrence);
    if (rule.FREQ !== "WEEKLY") {
      if (normalized.start < rangeEnd && rangeStart < normalized.end) {
        occurrences.push(occurrenceRecord(event, normalized.start, normalized.end, normalized.localStartDate));
      }
      return;
    }

    const byDays = (rule.BYDAY || DAY_CODES[(dayIndex(normalized.localStartDate) + 1) % 7])
      .split(",")
      .filter((code) => Object.hasOwn(DAY_INDEX_FROM_CODE, code));
    const interval = Math.max(1, Number(rule.INTERVAL) || 1);
    const until = parseRuleUntil(rule.UNTIL, normalized.timezone);
    const countLimit = /^\d+$/.test(String(rule.COUNT || "")) ? Math.max(1, Number(rule.COUNT)) : null;
    const weekStartCode = Object.hasOwn(DAY_INDEX_FROM_CODE, rule.WKST) ? rule.WKST : "MO";
    const baseWeekStart = startOfWeek(normalized.localStartDate, weekStartCode);
    const rangeStartLocal = dateString(partsInZone(rangeStart, normalized.timezone));
    const rangeEndLocal = dateString(partsInZone(new Date(rangeEnd.getTime() - 1), normalized.timezone));
    const calendarDurationDays = normalized.allDay
      ? Math.max(1, daysBetween(normalized.localStartDate, normalized.localEndDate))
      : null;
    const lookbackDays = calendarDurationDays || Math.max(1, Math.ceil(duration / 86400000));
    const lookbackStart = addDays(rangeStartLocal, -lookbackDays);
    const requestedIterationStart = lookbackStart;
    const iterationStart = daysBetween(normalized.localStartDate, requestedIterationStart) > 0
      ? requestedIterationStart
      : normalized.localStartDate;
    let occurrenceCount = countLimit
      ? countWeeklyOccurrencesBefore(normalized.localStartDate, iterationStart, byDays, interval, weekStartCode)
      : 0;
    if (countLimit && occurrenceCount >= countLimit) return;
    for (let date = iterationStart; date <= rangeEndLocal; date = addDays(date, 1)) {
      const code = Object.entries(DAY_INDEX_FROM_CODE).find(([, idx]) => idx === dayIndex(date))?.[0];
      if (!byDays.includes(code)) continue;
      const elapsedWeeks = Math.floor(daysBetween(baseWeekStart, startOfWeek(date, weekStartCode)) / 7);
      if (elapsedWeeks < 0 || elapsedWeeks % interval !== 0) continue;
      const start = zonedLocalToDate(date, normalized.localStartTime, normalized.timezone);
      if (!start || start < normalized.start) continue;
      if (until && start > until) break;
      occurrenceCount += 1;
      if (countLimit && occurrenceCount > countLimit) break;
      const end = normalized.allDay
        ? zonedLocalToDate(addDays(date, calendarDurationDays), "00:00", normalized.timezone)
        : new Date(start.getTime() + duration);
      if (!end) continue;
      if (start < rangeEnd && rangeStart < end) {
        occurrences.push(occurrenceRecord(event, start, end, date));
      }
    }
  });

  return occurrences.sort((a, b) => a.start.localeCompare(b.start));
}

function overlap(startA, endA, startB, endB) {
  return new Date(startA).getTime() < new Date(endB).getTime() && new Date(startB).getTime() < new Date(endA).getTime();
}

function findEventConflictForLesson(events, lessonAction, options = {}) {
  const timezone = options.timezone || studioTimezone();
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const startDate = lessonAction.specific_date || dateString(partsInZone(now, timezone));
  const endDate = lessonAction.specific_date ? addDays(startDate, 1) : addDays(startDate, 366);
  const rangeStart = zonedLocalToDate(startDate, "00:00", timezone);
  const rangeEnd = zonedLocalToDate(endDate, "00:00", timezone);
  const occurrences = expandCalendarEvents(events, { rangeStart, rangeEnd, timezone });
  for (let date = startDate; date < endDate; date = addDays(date, 1)) {
    if (!lessonAction.specific_date && dayIndex(date) !== Number(lessonAction.day_of_week)) continue;
    const lessonStart = zonedLocalToDate(date, lessonAction.start_time, timezone);
    const lessonEnd = zonedLocalToDate(date, lessonAction.end_time, timezone);
    if (!lessonStart || !lessonEnd || lessonStart >= lessonEnd) continue;
    const conflict = occurrences.find((occurrence) => overlap(
      occurrence.start,
      occurrence.end,
      lessonStart,
      lessonEnd
    ));
    if (conflict) return conflict;
  }
  return null;
}

function lessonOccurrences(lessons, exceptions, rangeStart, rangeEnd, timezone) {
  const cancellationKeys = new Set((exceptions || []).filter((item) => item.status === "cancelled").map((item) => `${item.lesson_id}:${item.exception_date}`));
  const startLocal = dateString(partsInZone(rangeStart, timezone));
  const endLocal = dateString(partsInZone(new Date(rangeEnd.getTime() - 1), timezone));
  const result = [];
  for (let date = startLocal; date <= endLocal; date = addDays(date, 1)) {
    (lessons || []).filter((lesson) => lesson.active !== false).forEach((lesson) => {
      const occurs = lesson.recurring === false
        ? lesson.specific_date === date
        : lesson.day_of_week === dayIndex(date);
      if (!occurs || cancellationKeys.has(`${lesson.id}:${date}`)) return;
      const start = zonedLocalToDate(date, lesson.start_time, timezone);
      const end = zonedLocalToDate(date, lesson.end_time, timezone);
      if (start && end && start < rangeEnd && rangeStart < end) result.push({ ...lesson, occurrenceDate: date, start, end });
    });
  }
  return result;
}

function expandLessonOccurrences(lessons, exceptions, options = {}) {
  const timezone = options.timezone || studioTimezone();
  const rangeStart = new Date(options.rangeStart);
  const rangeEnd = new Date(options.rangeEnd);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || rangeStart >= rangeEnd) return [];
  return lessonOccurrences(lessons, exceptions, rangeStart, rangeEnd, timezone)
    .sort((a, b) => a.start - b.start)
    .map((lesson) => ({
      ...lesson,
      start: lesson.start.toISOString().replace(".000Z", "Z"),
      end: lesson.end.toISOString().replace(".000Z", "Z"),
      startTime: lesson.start_time,
      endTime: lesson.end_time,
    }));
}

function findLessonConflictForEvent(lessons, exceptions, eventCandidate, options = {}) {
  const timezone = options.timezone || studioTimezone();
  const normalized = normalizedEventDates(eventCandidate, timezone);
  if (!normalized || normalized.start >= normalized.end) return null;
  return lessonOccurrences(lessons, exceptions, normalized.start, normalized.end, timezone)
    .find((lesson) => overlap(lesson.start, lesson.end, normalized.start, normalized.end)) || null;
}

function findCalendarEventConflict(events, eventCandidate, options = {}) {
  const timezone = options.timezone || studioTimezone();
  const normalized = normalizedEventDates(eventCandidate, timezone);
  if (!normalized || normalized.start >= normalized.end) return null;
  const candidates = (events || []).filter((event) => event.id !== options.excludeId);
  return expandCalendarEvents(candidates, {
    rangeStart: normalized.start,
    rangeEnd: normalized.end,
    timezone,
  }).find((occurrence) => overlap(occurrence.start, occurrence.end, normalized.start, normalized.end)) || null;
}

function currentStudioWeek(options = {}) {
  const timezone = options.timezone || studioTimezone();
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const localDate = dateString(partsInZone(now, timezone));
  const monday = addDays(localDate, -dayIndex(localDate));
  return {
    rangeStart: zonedLocalToUtc(monday, "00:00", timezone),
    rangeEnd: zonedLocalToUtc(addDays(monday, 7), "00:00", timezone),
    timezone,
  };
}

function studioMonth(options = {}) {
  const timezone = options.timezone || studioTimezone();
  const match = String(options.month || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (!Number.isInteger(year) || monthNumber < 1 || monthNumber > 12) return null;
  const month = `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}`;
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const rangeStart = zonedLocalToUtc(`${month}-01`, "00:00", timezone);
  const rangeEnd = zonedLocalToUtc(
    `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`,
    "00:00",
    timezone
  );
  if (!rangeStart || !rangeEnd) return null;
  return { month, rangeStart, rangeEnd, timezone };
}

module.exports = {
  studioTimezone,
  partsInZone,
  zonedLocalToUtc,
  expandCalendarEvents,
  findEventConflictForLesson,
  findLessonConflictForEvent,
  expandLessonOccurrences,
  findCalendarEventConflict,
  currentStudioWeek,
  studioMonth,
};
