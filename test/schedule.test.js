const test = require("node:test");
const assert = require("node:assert/strict");

const {
  zonedLocalToUtc,
  expandCalendarEvents,
  findEventConflictForLesson,
  findLessonConflictForEvent,
  expandLessonOccurrences,
  findCalendarEventConflict,
} = require("../netlify/functions/_schedule");

test("converts studio wall time to UTC across daylight-saving time", () => {
  assert.equal(zonedLocalToUtc("2026-09-03", "19:30", "America/Chicago"), "2026-09-04T00:30:00Z");
  assert.equal(zonedLocalToUtc("2026-12-03", "19:30", "America/Chicago"), "2026-12-04T01:30:00Z");
});

test("expands weekly imported commitments into a concrete date range", () => {
  const occurrences = expandCalendarEvents([{
    id: 5,
    uid: "weekly-5",
    title: "Orchestra rehearsal",
    start: "2026-09-03T21:00:00Z",
    end: "2026-09-03T23:00:00Z",
    timezone: "America/Chicago",
    recurrence: "FREQ=WEEKLY;BYDAY=TH",
  }], {
    rangeStart: "2026-09-07T00:00:00Z",
    rangeEnd: "2026-09-14T00:00:00Z",
    timezone: "America/Chicago",
  });

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].start, "2026-09-10T21:00:00Z");
  assert.equal(occurrences[0].end, "2026-09-10T23:00:00Z");
});

test("weekly imported commitment conflicts on later occurrences", () => {
  const conflict = findEventConflictForLesson([{
    id: 5,
    start: "2026-09-03T21:00:00Z",
    end: "2026-09-03T23:00:00Z",
    timezone: "America/Chicago",
    recurrence: "FREQ=WEEKLY;BYDAY=TH",
  }], {
    specific_date: "2026-09-10",
    day_of_week: 3,
    start_time: "16:30",
    end_time: "17:30",
  }, { timezone: "America/Chicago", now: new Date("2026-09-01T12:00:00Z") });

  assert.equal(conflict.id, 5);
});

test("historical one-off commitment does not block a new recurring lesson", () => {
  const conflict = findEventConflictForLesson([{
    id: 6,
    start: "2026-01-01T22:00:00Z",
    end: "2026-01-02T00:00:00Z",
    timezone: "America/Chicago",
    recurrence: null,
  }], {
    specific_date: null,
    day_of_week: 3,
    start_time: "16:30",
    end_time: "17:30",
  }, { timezone: "America/Chicago", now: new Date("2026-09-01T12:00:00Z") });

  assert.equal(conflict, null);
});

test("one-off lesson on another date does not block a professional event", () => {
  const conflict = findLessonConflictForEvent([{
    id: 4,
    student: "Maya",
    day_of_week: 3,
    start_time: "16:00",
    end_time: "17:00",
    recurring: false,
    specific_date: "2026-09-03",
    active: true,
  }], [], {
    start: "2026-09-10T21:30:00Z",
    end: "2026-09-10T22:30:00Z",
  }, { timezone: "America/Chicago" });

  assert.equal(conflict, null);
});

test("lesson occurrences honor concrete dates and cancellation exceptions", () => {
  const lessons = [
    { id: 1, student: "Weekly", day_of_week: 3, start_time: "16:00", end_time: "17:00", recurring: true, active: true },
    { id: 2, student: "Past", day_of_week: 3, start_time: "17:00", end_time: "18:00", recurring: false, specific_date: "2026-09-03", active: true },
    { id: 3, student: "This week", day_of_week: 3, start_time: "18:00", end_time: "19:00", recurring: false, specific_date: "2026-09-10", active: true },
  ];
  const occurrences = expandLessonOccurrences(lessons, [
    { lesson_id: 1, exception_date: "2026-09-10", status: "cancelled" },
  ], {
    rangeStart: "2026-09-07T05:00:00Z",
    rangeEnd: "2026-09-14T05:00:00Z",
    timezone: "America/Chicago",
  });

  assert.deepEqual(occurrences.map((item) => item.student), ["This week"]);
  assert.equal(occurrences[0].occurrenceDate, "2026-09-10");
});

test("professional event conflicts include later recurring occurrences", () => {
  const conflict = findCalendarEventConflict([{
    id: 8,
    start: "2026-09-03T21:00:00Z",
    end: "2026-09-03T23:00:00Z",
    timezone: "America/Chicago",
    recurrence: "FREQ=WEEKLY;BYDAY=TH",
  }], {
    start: "2026-09-10T21:30:00Z",
    end: "2026-09-10T22:30:00Z",
  }, { timezone: "America/Chicago" });

  assert.equal(conflict.id, 8);
});

test("weekly recurrence stops at its UNTIL boundary", () => {
  const occurrences = expandCalendarEvents([{
    id: 9,
    start: "2026-09-03T21:00:00Z",
    end: "2026-09-03T23:00:00Z",
    timezone: "America/Chicago",
    recurrence: "FREQ=WEEKLY;BYDAY=TH;UNTIL=20260904T000000Z",
  }], {
    rangeStart: "2026-09-07T00:00:00Z",
    rangeEnd: "2026-09-14T00:00:00Z",
    timezone: "America/Chicago",
  });

  assert.equal(occurrences.length, 0);
});

test("a commitment beginning the previous day still conflicts after midnight", () => {
  const conflict = findEventConflictForLesson([{
    id: 10,
    start: "2026-09-03T04:00:00Z",
    end: "2026-09-03T06:00:00Z",
    timezone: "America/Chicago",
    recurrence: "FREQ=WEEKLY;BYDAY=WE",
  }], {
    specific_date: "2026-09-03",
    day_of_week: 3,
    start_time: "00:30",
    end_time: "01:30",
  }, { timezone: "America/Chicago", now: new Date("2026-09-01T12:00:00Z") });

  assert.equal(conflict?.id, 10);
});

test("a multi-day all-day commitment conflicts on each covered date", () => {
  const conflict = findEventConflictForLesson([{
    id: 11,
    start: "2026-09-07",
    end: "2026-09-10",
    timezone: "America/Chicago",
    allDay: true,
  }], {
    specific_date: "2026-09-08",
    day_of_week: 1,
    start_time: "12:00",
    end_time: "13:00",
  }, { timezone: "America/Chicago", now: new Date("2026-09-01T12:00:00Z") });

  assert.equal(conflict?.id, 11);
});

test("weekly recurrence COUNT limits generated commitments", () => {
  const occurrences = expandCalendarEvents([{
    id: 12,
    start: "2026-09-03T21:00:00Z",
    end: "2026-09-03T22:00:00Z",
    timezone: "America/Chicago",
    recurrence: "FREQ=WEEKLY;BYDAY=TH;COUNT=2",
  }], {
    rangeStart: "2026-09-17T05:00:00Z",
    rangeEnd: "2026-09-18T05:00:00Z",
    timezone: "America/Chicago",
  });

  assert.equal(occurrences.length, 0);
});

test("interval recurrences anchor multiple weekdays to WKST", () => {
  const occurrences = expandCalendarEvents([{
    id: 13,
    start: "2026-09-03T21:00:00Z",
    end: "2026-09-03T22:00:00Z",
    timezone: "America/Chicago",
    recurrence: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;WKST=MO",
  }], {
    rangeStart: "2026-09-14T05:00:00Z",
    rangeEnd: "2026-09-15T05:00:00Z",
    timezone: "America/Chicago",
  });

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].date, "2026-09-14");
});

test("multi-day all-day commitments expose every display date", () => {
  const occurrences = expandCalendarEvents([{
    id: 14,
    start: "2026-09-07",
    end: "2026-09-10",
    timezone: "America/Chicago",
    allDay: true,
  }], {
    rangeStart: "2026-09-07T05:00:00Z",
    rangeEnd: "2026-09-14T05:00:00Z",
    timezone: "America/Chicago",
  });

  assert.deepEqual(occurrences[0].displayDates, ["2026-09-07", "2026-09-08", "2026-09-09"]);
});

test("all-day weekly recurrences retain local-midnight duration across DST", () => {
  const conflict = findEventConflictForLesson([{
    id: 15,
    start: "2026-10-25",
    end: "2026-10-26",
    timezone: "America/Chicago",
    allDay: true,
    recurrence: "FREQ=WEEKLY;BYDAY=SU",
  }], {
    specific_date: "2026-11-01",
    day_of_week: 6,
    start_time: "23:30",
    end_time: "23:45",
  }, { timezone: "America/Chicago", now: new Date("2026-10-20T12:00:00Z") });

  assert.equal(conflict?.id, 15);
  assert.equal(conflict?.end, "2026-11-02T06:00:00Z");
});

test("display dates are clipped to the requested week", () => {
  const occurrences = expandCalendarEvents([{
    id: 16,
    start: "2026-09-01",
    end: "2026-09-20",
    timezone: "America/Chicago",
    allDay: true,
  }], {
    rangeStart: "2026-09-07T05:00:00Z",
    rangeEnd: "2026-09-14T05:00:00Z",
    timezone: "America/Chicago",
  });

  assert.deepEqual(occurrences[0].displayDates, [
    "2026-09-07",
    "2026-09-08",
    "2026-09-09",
    "2026-09-10",
    "2026-09-11",
    "2026-09-12",
    "2026-09-13",
  ]);
});

test("timed commitments spanning midnight expose both visible dates", () => {
  const occurrences = expandCalendarEvents([{
    id: 17,
    start: "2026-09-08T04:00:00Z",
    end: "2026-09-08T06:00:00Z",
    timezone: "America/Chicago",
  }], {
    rangeStart: "2026-09-07T05:00:00Z",
    rangeEnd: "2026-09-14T05:00:00Z",
    timezone: "America/Chicago",
  });

  assert.deepEqual(occurrences[0].displayDates, ["2026-09-07", "2026-09-08"]);
  assert.deepEqual(occurrences[0].displaySegments, [
    { date: "2026-09-07", startTime: "23:00", endTime: "23:59" },
    { date: "2026-09-08", startTime: "00:00", endTime: "01:00" },
  ]);
});
