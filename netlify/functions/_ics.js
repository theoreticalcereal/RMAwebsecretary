const DAY_TO_ICAL = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

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
    content: `${lines.join("\r\n")}\r\n`,
    contentType: `text/calendar; method=${normalizedMethod}; charset=utf-8`,
  };
}

module.exports = { buildLessonInvite };
