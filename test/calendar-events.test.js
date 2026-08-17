const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseCalendar,
  mergeCalendarEvents,
  buildScheduleCalendar,
  eventConflicts,
} = require("../netlify/functions/_ics");

test("parses Apple Calendar events with folded text and TZID dates", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:apple-1@example.com",
    "DTSTART;TZID=America/Chicago:20260903T193000",
    "DTEND;TZID=America/Chicago:20260903T213000",
    "SUMMARY:Faculty Concert",
    "LOCATION:Kimball Hall",
    "DESCRIPTION:Call time at 18:30 with the chamber ensemble and",
    "  stage manager.",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const result = parseCalendar(source, { source: "apple-file" });

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    uid: "apple-1@example.com",
    title: "Faculty Concert",
    eventType: "concert",
    start: "2026-09-04T00:30:00Z",
    end: "2026-09-04T02:30:00Z",
    timezone: "America/Chicago",
    allDay: false,
    location: "Kimball Hall",
    notes: "Call time at 18:30 with the chamber ensemble and stage manager.",
    recurrence: null,
    source: "apple-file",
    private: true,
  });
});

test("parses UTC and all-day values and skips malformed events", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:utc-1",
    "DTSTART:20261002T010000Z",
    "DTEND:20261002T023000Z",
    "SUMMARY:Orchestra Rehearsal",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:day-1",
    "DTSTART;VALUE=DATE:20261004",
    "DTEND;VALUE=DATE:20261005",
    "SUMMARY:Travel day",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:broken",
    "SUMMARY:Missing dates",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");

  const result = parseCalendar(source);

  assert.equal(result.events.length, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.events[0].start, "2026-10-02T01:00:00Z");
  assert.equal(result.events[0].eventType, "rehearsal");
  assert.equal(result.events[1].start, "2026-10-04");
  assert.equal(result.events[1].allDay, true);
  assert.equal(result.events[1].eventType, "unavailable");
});

test("skips impossible dates and incoherent event ranges", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:impossible",
    "DTSTART:20261399T999999",
    "DTEND:20261400T100000",
    "SUMMARY:Impossible",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:backwards",
    "DTSTART:20260903T180000",
    "DTEND:20260903T170000",
    "SUMMARY:Backwards",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const result = parseCalendar(source);
  assert.equal(result.events.length, 0);
  assert.equal(result.skipped, 2);
});

test("skips recurrence counts that exceed the safe import limit", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:unbounded-count",
    "DTSTART:19000104T160000Z",
    "DTEND:19000104T170000Z",
    "RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=1000000",
    "SUMMARY:Unbounded recurrence",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const result = parseCalendar(source);

  assert.equal(result.events.length, 0);
  assert.equal(result.skipped, 1);
});

test("rejects incomplete calendar containers", () => {
  assert.throws(
    () => parseCalendar("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT"),
    /valid iCalendar/i
  );
});

test("merges calendar events by UID without multiplying imports", () => {
  const existing = [{ id: 7, uid: "same", title: "Old", start: "2026-09-01T10:00:00", end: "2026-09-01T11:00:00" }];
  const incoming = [
    { uid: "same", title: "Updated", start: "2026-09-01T10:00:00", end: "2026-09-01T12:00:00" },
    { uid: "new", title: "New", start: "2026-09-02T10:00:00", end: "2026-09-02T11:00:00" },
  ];

  const result = mergeCalendarEvents(existing, incoming);

  assert.equal(result.imported, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.events.length, 2);
  assert.equal(result.events.find((event) => event.uid === "same").id, 7);
  assert.equal(result.events.find((event) => event.uid === "same").title, "Updated");
  assert.equal(result.events.find((event) => event.uid === "new").id, 8);
});

test("exports lessons and professional events as one calendar", () => {
  const output = buildScheduleCalendar({
    calendarName: "Studio & Stage",
    lessons: [{
      id: 4,
      student: "Maya",
      subject: "Violin",
      day_of_week: 2,
      start_time: "16:00",
      end_time: "17:00",
      recurring: true,
    }],
    events: [{
      id: 9,
      uid: "concert-9",
      title: "Solo Recital, Series A",
      eventType: "concert",
      start: "2026-09-03T19:30:00",
      end: "2026-09-03T21:00:00",
      location: "Hall; Main",
      notes: "Doors open\nearly",
    }],
  });

  assert.equal(output.filename, "studio-stage.ics");
  assert.equal(output.contentType, "text/calendar; charset=utf-8");
  assert.match(output.content, /X-WR-CALNAME:Studio & Stage/);
  assert.match(output.content, /SUMMARY:Violin with Maya/);
  assert.match(output.content, /RRULE:FREQ=WEEKLY;BYDAY=WE/);
  assert.match(output.content, /SUMMARY:Solo Recital\\, Series A/);
  assert.match(output.content, /LOCATION:Hall\\; Main/);
  assert.match(output.content, /DESCRIPTION:Doors open\\nearly/);
});

test("folds long UTF-8 export lines and remains importable", () => {
  const output = buildScheduleCalendar({
    events: [{
      id: 12,
      uid: "long-12",
      title: "International artists’ concert — 東京からの特別ゲストと室内楽の夕べ",
      eventType: "concert",
      start: "2026-09-04T00:30:00Z",
      end: "2026-09-04T02:30:00Z",
      notes: "A long description with accented names: José, Françoise, and Søren. Please arrive through the stage entrance.",
    }],
  });

  output.content.split("\r\n").filter(Boolean).forEach((line) => {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line exceeded 75 octets: ${line}`);
  });
  const roundTrip = parseCalendar(output.content);
  assert.equal(roundTrip.events[0].title, "International artists’ concert — 東京からの特別ゲストと室内楽の夕べ");
});

test("exports timezone-aware recurring events as portable UTC occurrences", () => {
  const output = buildScheduleCalendar({
    now: new Date("2026-09-01T12:00:00Z"),
    events: [{
      id: 20,
      uid: "weekly-20",
      title: "Thursday rehearsal",
      eventType: "rehearsal",
      start: "2026-09-03T21:00:00Z",
      end: "2026-09-03T23:00:00Z",
      timezone: "America/Chicago",
      recurrence: "FREQ=WEEKLY;BYDAY=TH",
    }],
  });

  assert.doesNotMatch(output.content, /TZID=America\/Chicago/);
  assert.doesNotMatch(output.content, /RRULE:FREQ=WEEKLY;BYDAY=TH/);
  assert.match(output.content, /DTSTART:20260903T210000Z/);
  assert.match(output.content, /UID:weekly-20-2026-09-03/);
});

test("detects overlap without exposing event details", () => {
  const events = [{
    id: 2,
    title: "Private audition",
    start: "2026-09-03T16:00:00",
    end: "2026-09-03T18:00:00",
  }];

  assert.equal(eventConflicts(events, {
    start: "2026-09-03T17:30:00",
    end: "2026-09-03T18:30:00",
  }).id, 2);
  assert.equal(eventConflicts(events, {
    start: "2026-09-03T18:00:00",
    end: "2026-09-03T19:00:00",
  }), null);
});
