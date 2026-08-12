const test = require("node:test");
const assert = require("node:assert/strict");

const { buildLessonInvite } = require("../netlify/functions/_ics");

test("builds weekly lesson invites with recurrence and alarms", () => {
  const invite = buildLessonInvite({
    lesson: {
      id: 7,
      student: "Ricky",
      subject: "Cello",
      day_of_week: 0,
      start_time: "16:00",
      end_time: "17:00",
      recurring: true,
      specific_date: null,
    },
    method: "REQUEST",
    sequence: 0,
    organizerEmail: "teacher@example.com",
    attendeeEmail: "ricky@example.com",
    offsetsMinutes: [60, 1440],
  });

  assert.equal(invite.filename, "lesson-7.ics");
  assert.equal(invite.contentType, "text/calendar; method=REQUEST; charset=utf-8");
  assert.match(invite.content, /METHOD:REQUEST/);
  assert.match(invite.content, /SUMMARY:Cello with Ricky/);
  assert.match(invite.content, /RRULE:FREQ=WEEKLY/);
  assert.match(invite.content, /DTSTART:\d{8}T160000/);
  assert.match(invite.content, /TRIGGER:-PT60M/);
  assert.match(invite.content, /TRIGGER:-PT1440M/);
});

test("builds one-off lesson invites without recurrence", () => {
  const invite = buildLessonInvite({
    lesson: {
      id: 8,
      student: "Avery",
      subject: "Geometry",
      day_of_week: 2,
      start_time: "09:30",
      end_time: "10:30",
      recurring: false,
      specific_date: "2026-09-03",
    },
    method: "REQUEST",
    sequence: 1,
    organizerEmail: "teacher@example.com",
    attendeeEmail: "avery@example.com",
    offsetsMinutes: [15],
  });

  assert.doesNotMatch(invite.content, /RRULE:/);
  assert.match(invite.content, /DTSTART:20260903T093000/);
  assert.match(invite.content, /DTEND:20260903T103000/);
  assert.match(invite.content, /TRIGGER:-PT15M/);
});

test("builds cancellation invites with cancel method and cancelled status", () => {
  const invite = buildLessonInvite({
    lesson: {
      id: 9,
      student: "Sam",
      subject: "Piano",
      day_of_week: 4,
      start_time: "18:00",
      end_time: "19:00",
      recurring: true,
      specific_date: null,
    },
    method: "CANCEL",
    sequence: 2,
    organizerEmail: "teacher@example.com",
    attendeeEmail: "sam@example.com",
    offsetsMinutes: [],
  });

  assert.equal(invite.contentType, "text/calendar; method=CANCEL; charset=utf-8");
  assert.match(invite.content, /METHOD:CANCEL/);
  assert.match(invite.content, /STATUS:CANCELLED/);
  assert.doesNotMatch(invite.content, /BEGIN:VALARM/);
});
