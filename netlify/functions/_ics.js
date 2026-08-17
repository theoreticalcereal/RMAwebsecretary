const DAY_TO_ICAL = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const { zonedLocalToUtc, studioTimezone, expandCalendarEvents } = require("./_schedule");

function pad2(value) {
  return String(value).padStart(2, "0");
}

function escapeIcsText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function unescapeIcsText(value) {
  return String(value || "")
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function unfoldIcsLines(text) {
  const rawLines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines = [];
  rawLines.forEach((line) => {
    if (/^[ \t]/.test(line) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  });
  return lines;
}

function parseProperty(line) {
  const separator = line.indexOf(":");
  if (separator === -1) return null;
  const left = line.slice(0, separator);
  const value = line.slice(separator + 1);
  const [rawName, ...rawParams] = left.split(";");
  const params = {};
  rawParams.forEach((rawParam) => {
    const equals = rawParam.indexOf("=");
    if (equals === -1) return;
    params[rawParam.slice(0, equals).toUpperCase()] = rawParam.slice(equals + 1).replace(/^"|"$/g, "");
  });
  return { name: rawName.toUpperCase(), params, value };
}

function parseIcsDate(rawValue, params = {}, fallbackTimezone = studioTimezone()) {
  const value = String(rawValue || "").trim();
  if (/^\d{8}$/.test(value) || String(params.VALUE || "").toUpperCase() === "DATE") {
    if (!/^\d{8}$/.test(value)) return null;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6));
    const day = Number(value.slice(6, 8));
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return {
      value: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
      allDay: true,
      timezone: null,
    };
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00", utc] = match;
  const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (check.getUTCFullYear() !== Number(year)
      || check.getUTCMonth() !== Number(month) - 1
      || check.getUTCDate() !== Number(day)
      || check.getUTCHours() !== Number(hour)
      || check.getUTCMinutes() !== Number(minute)
      || check.getUTCSeconds() !== Number(second)) return null;
  const timezone = utc ? null : (params.TZID || fallbackTimezone);
  const dateValue = `${year}-${month}-${day}`;
  const timeValue = `${hour}:${minute}:${second}`;
  const normalized = utc
    ? `${dateValue}T${timeValue}Z`
    : zonedLocalToUtc(dateValue, timeValue, timezone);
  if (!normalized) return null;
  return {
    value: normalized,
    allDay: false,
    timezone,
  };
}

function inferEventType(title) {
  const normalized = String(title || "").toLowerCase();
  if (/\b(concert|recital|performance|gig)\b/.test(normalized)) return "concert";
  if (/\b(rehearsal|sound[ -]?check)\b/.test(normalized)) return "rehearsal";
  return "unavailable";
}

function stableImportedUid(title, start, end) {
  const source = `${title}|${start}|${end}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `import-${(hash >>> 0).toString(16)}@studio-stage`;
}

function safeImportedRecurrence(rawRule) {
  const rule = String(rawRule || "").trim();
  if (!rule) return true;
  const countMatch = rule.match(/(?:^|;)COUNT=(\d+)(?:;|$)/i);
  if (!countMatch) return true;
  const count = Number(countMatch[1]);
  return Number.isSafeInteger(count) && count >= 1 && count <= 10000;
}

function parseCalendar(text, options = {}) {
  const lines = unfoldIcsLines(text);
  if (!lines.some((line) => line.trim().toUpperCase() === "BEGIN:VCALENDAR")
      || !lines.some((line) => line.trim().toUpperCase() === "END:VCALENDAR")) {
    throw new Error("This file is not a valid iCalendar calendar.");
  }

  const events = [];
  let skipped = 0;
  let current = null;

  lines.forEach((line) => {
    const normalized = line.trim().toUpperCase();
    if (normalized === "BEGIN:VEVENT") {
      current = {};
      return;
    }
    if (normalized === "END:VEVENT") {
      if (!current) return;
      const fallbackTimezone = options.timezone || studioTimezone();
      const start = current.DTSTART ? parseIcsDate(current.DTSTART.value, current.DTSTART.params, fallbackTimezone) : null;
      const end = current.DTEND ? parseIcsDate(current.DTEND.value, current.DTEND.params, fallbackTimezone) : null;
      const invalidRange = start && end && (
        start.allDay !== end.allDay
        || (start.allDay ? start.value >= end.value : new Date(start.value).getTime() >= new Date(end.value).getTime())
      );
      if (!start || !end || invalidRange || !safeImportedRecurrence(current.RRULE?.value)) {
        skipped += 1;
        current = null;
        return;
      }
      const title = unescapeIcsText(current.SUMMARY?.value || "Unavailable");
      const timezone = start.timezone || null;
      events.push({
        uid: unescapeIcsText(current.UID?.value) || stableImportedUid(title, start.value, end.value),
        title,
        eventType: inferEventType(title),
        start: start.value,
        end: end.value,
        timezone,
        allDay: start.allDay,
        location: unescapeIcsText(current.LOCATION?.value),
        notes: unescapeIcsText(current.DESCRIPTION?.value),
        recurrence: current.RRULE?.value || null,
        source: options.source || "ics",
        private: true,
      });
      current = null;
      return;
    }
    if (!current) return;
    const property = parseProperty(line);
    if (property && !current[property.name]) current[property.name] = property;
  });

  return { events, skipped };
}

function mergeCalendarEvents(existingEvents, incomingEvents) {
  const events = (Array.isArray(existingEvents) ? existingEvents : []).map((event) => ({ ...event }));
  let imported = 0;
  let updated = 0;
  let nextEventId = events.length
    ? Math.max(...events.map((event) => Number(event.id) || 0)) + 1
    : 1;

  (Array.isArray(incomingEvents) ? incomingEvents : []).forEach((incoming) => {
    const index = events.findIndex((event) => event.uid && incoming.uid && event.uid === incoming.uid);
    if (index >= 0) {
      events[index] = { ...events[index], ...incoming, id: events[index].id };
      updated += 1;
      return;
    }
    events.push({ ...incoming, id: nextEventId });
    nextEventId += 1;
    imported += 1;
  });

  events.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
  return { events, imported, updated };
}

function normalizeComparableDate(value, isEnd = false) {
  const raw = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const suffix = isEnd ? "T00:00:00" : "T00:00:00";
    const parsed = new Date(`${raw}${suffix}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function eventConflicts(events, candidate, excludeId = null) {
  const candidateStart = normalizeComparableDate(candidate?.start);
  const candidateEnd = normalizeComparableDate(candidate?.end, true);
  if (candidateStart === null || candidateEnd === null || candidateStart >= candidateEnd) return null;
  return (Array.isArray(events) ? events : []).find((event) => {
    if (event.id === excludeId) return false;
    const start = normalizeComparableDate(event.start);
    const end = normalizeComparableDate(event.end, true);
    return start !== null && end !== null && start < candidateEnd && candidateStart < end;
  }) || null;
}

function formatDateTime(date, time) {
  const [hour, minute] = String(time || "00:00").split(":").map(Number);
  return `${date.replace(/-/g, "")}T${pad2(hour)}${pad2(minute)}00`;
}

function formatUtcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function nextDateForLesson(lesson, now = new Date()) {
  if (lesson.specific_date) return lesson.specific_date;

  const targetJsDay = ((Number(lesson.day_of_week) || 0) + 1) % 7;
  const candidate = new Date(now);
  candidate.setHours(0, 0, 0, 0);
  const delta = (targetJsDay - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + delta);
  return [
    candidate.getFullYear(),
    pad2(candidate.getMonth() + 1),
    pad2(candidate.getDate()),
  ].join("-");
}

function lessonSummary(lesson) {
  const subject = String(lesson.subject || "").trim();
  const student = String(lesson.student || "Lesson").trim();
  return subject ? `${subject} with ${student}` : `Lesson with ${student}`;
}

function buildAlarm(offsetMinutes) {
  return [
    "BEGIN:VALARM",
    `TRIGGER:-PT${offsetMinutes}M`,
    "ACTION:DISPLAY",
    "DESCRIPTION:Lesson reminder",
    "END:VALARM",
  ];
}

function foldIcsLine(line) {
  const segments = [];
  let current = "";
  let limit = 75;
  for (const character of String(line)) {
    const next = current + character;
    if (Buffer.byteLength(next, "utf8") > limit && current) {
      segments.push(segments.length ? ` ${current}` : current);
      current = character;
      limit = 74;
    } else {
      current = next;
    }
  }
  segments.push(segments.length ? ` ${current}` : current);
  return segments;
}

function serializeIcsLines(lines) {
  return `${lines.flatMap(foldIcsLine).join("\r\n")}\r\n`;
}

function buildLessonInvite({
  lesson,
  method = "REQUEST",
  sequence = 0,
  organizerEmail,
  attendeeEmail,
  offsetsMinutes = [],
}) {
  const normalizedMethod = String(method || "REQUEST").toUpperCase() === "CANCEL" ? "CANCEL" : "REQUEST";
  const startDate = nextDateForLesson(lesson);
  const uid = `lesson-${lesson.id}@lesson-secretary`;
  const summary = lessonSummary(lesson);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lesson Secretary//Lesson Calendar//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${normalizedMethod}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${Math.max(0, Math.floor(Number(sequence) || 0))}`,
    `DTSTAMP:${formatUtcStamp()}`,
    `DTSTART:${formatDateTime(startDate, lesson.start_time)}`,
    `DTEND:${formatDateTime(startDate, lesson.end_time)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText("Lesson scheduled by Lesson Secretary.")}`,
  ];

  if (organizerEmail) {
    lines.push(`ORGANIZER:mailto:${organizerEmail}`);
  }
  if (attendeeEmail) {
    lines.push(`ATTENDEE;CN=${escapeIcsText(attendeeEmail)};ROLE=REQ-PARTICIPANT:mailto:${attendeeEmail}`);
  }
  if (lesson.recurring !== false) {
    lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${DAY_TO_ICAL[lesson.day_of_week] || "MO"}`);
  }
  if (normalizedMethod === "CANCEL") {
    lines.push("STATUS:CANCELLED");
  }

  const alarms = Array.isArray(offsetsMinutes)
    ? Array.from(new Set(offsetsMinutes.map((value) => Math.floor(Number(value))).filter((value) => value >= 0)))
    : [];
  alarms.forEach((offset) => lines.push(...buildAlarm(offset)));

  lines.push("END:VEVENT", "END:VCALENDAR");

  return {
    filename: `lesson-${lesson.id}.ics`,
    content: serializeIcsLines(lines),
    contentType: `text/calendar; method=${normalizedMethod}; charset=utf-8`,
  };
}

function formatCalendarDate(property, value, timezone, allDay = false) {
  const raw = String(value || "");
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${property};VALUE=DATE:${raw.replace(/-/g, "")}`;
  }
  const compact = raw.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  if (compact.endsWith("Z")) return `${property}:${compact}`;
  return timezone ? `${property};TZID=${timezone}:${compact}` : `${property}:${compact}`;
}

function buildScheduleCalendar({ lessons = [], events = [], calendarName = "Studio & Stage", now = new Date() } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Studio & Stage//Music Schedule//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
  ];
  const stamp = formatUtcStamp();

  lessons.filter((lesson) => lesson.active !== false).forEach((lesson) => {
    const startDate = nextDateForLesson(lesson);
    lines.push(
      "BEGIN:VEVENT",
      `UID:lesson-${lesson.id}@lesson-secretary`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatDateTime(startDate, lesson.start_time)}`,
      `DTEND:${formatDateTime(startDate, lesson.end_time)}`,
      `SUMMARY:${escapeIcsText(lessonSummary(lesson))}`,
      "CATEGORIES:LESSON"
    );
    if (lesson.recurring !== false) {
      lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${DAY_TO_ICAL[lesson.day_of_week] || "MO"}`);
    }
    lines.push("END:VEVENT");
  });

  const horizonEnd = new Date(now);
  horizonEnd.setUTCFullYear(horizonEnd.getUTCFullYear() + 2);
  const exportedEvents = events.flatMap((event) => {
    if (!event.recurrence || !event.timezone) return [event];
    return expandCalendarEvents([event], {
      rangeStart: now,
      rangeEnd: horizonEnd,
      timezone: event.timezone,
    }).map((occurrence) => ({
      ...occurrence,
      uid: `${event.uid || `event-${event.id}@studio-stage`}-${occurrence.date}`,
      timezone: null,
      recurrence: null,
    }));
  });

  exportedEvents.forEach((event) => {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcsText(event.uid || `event-${event.id}@studio-stage`)}`,
      `DTSTAMP:${stamp}`,
      formatCalendarDate("DTSTART", event.start, event.timezone, event.allDay),
      formatCalendarDate("DTEND", event.end, event.timezone, event.allDay),
      `SUMMARY:${escapeIcsText(event.title || "Unavailable")}`,
      `CATEGORIES:${String(event.eventType || "unavailable").toUpperCase()}`
    );
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    if (event.notes) lines.push(`DESCRIPTION:${escapeIcsText(event.notes)}`);
    if (event.recurrence) lines.push(`RRULE:${event.recurrence}`);
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return {
    filename: "studio-stage.ics",
    content: serializeIcsLines(lines),
    contentType: "text/calendar; charset=utf-8",
  };
}

module.exports = {
  buildLessonInvite,
  parseCalendar,
  mergeCalendarEvents,
  buildScheduleCalendar,
  eventConflicts,
};
