const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function loadFunction(path, mocks) {
  const functionPath = require.resolve(path);
  delete require.cache[functionPath];
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    const parentFile = String(parent?.filename || "");
    if (parentFile.includes("netlify/functions/") && mocks[request]) return mocks[request];
    if (request === "@netlify/blobs") {
      return { connectLambda() {}, getStore() { return {}; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

function createStoreMock() {
  const state = {
    lessons: [{ id: 1, student: "Maya", subject: "Violin", day_of_week: 2, start_time: "16:00", end_time: "17:00", recurring: true, active: true }],
    events: [{ id: 3, uid: "private-3", title: "Audition with Chicago Symphony", eventType: "concert", start: "2026-09-03T16:00:00", end: "2026-09-03T18:00:00", location: "Orchestra Hall", private: true }],
  };
  return {
    state,
    module: {
      getLessonStore() { return state; },
      async readLessons() { return state.lessons; },
      async readExceptions() { return []; },
      async readCalendarEvents() { return state.events; },
      async writeCalendarEvents(_store, events) { state.events = events; },
      jsonResponse,
      nextId(items) { return items.length ? Math.max(...items.map((item) => item.id)) + 1 : 1; },
    },
  };
}

test("public calendar exposes private commitments only as unavailable", async () => {
  const store = createStoreMock();
  const fn = loadFunction("../netlify/functions/lessons", { "./_store": store.module });

  const response = await fn.handler({ httpMethod: "GET" });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.busyEvents.length, 1);
  assert.deepEqual(body.busyEvents[0], {
    id: 3,
    title: "Unavailable",
    eventType: "unavailable",
    start: "2026-09-03T16:00:00",
    end: "2026-09-03T18:00:00",
    allDay: false,
    recurrence: null,
  });
  assert.doesNotMatch(response.body, /Audition|Chicago Symphony|Orchestra Hall/);
});

test("public calendar exposes each covered all-day date as unavailable", async () => {
  const store = createStoreMock();
  store.state.events = [{
    id: 7,
    uid: "tour-7",
    title: "Private festival engagement",
    eventType: "concert",
    start: "2026-09-07",
    end: "2026-09-10",
    timezone: "America/Chicago",
    allDay: true,
    location: "Confidential venue",
    private: true,
  }];
  const schedule = require("../netlify/functions/_schedule");
  const week = {
    rangeStart: "2026-09-07T05:00:00Z",
    rangeEnd: "2026-09-14T05:00:00Z",
    timezone: "America/Chicago",
  };
  const fn = loadFunction("../netlify/functions/lessons", {
    "./_store": store.module,
    "./_schedule": { ...schedule, currentStudioWeek() { return week; } },
  });

  const response = await fn.handler({ httpMethod: "GET" });
  const body = JSON.parse(response.body);

  assert.deepEqual(body.busyOccurrences.map((event) => event.date), [
    "2026-09-07",
    "2026-09-08",
    "2026-09-09",
  ]);
  assert.ok(body.busyOccurrences.every((event) => event.title === "Unavailable" && event.startTime === "00:00"));
  assert.doesNotMatch(response.body, /festival|Confidential/i);
});

test("admin imports and updates Apple Calendar events by UID", async () => {
  const store = createStoreMock();
  const fn = loadFunction("../netlify/functions/calendar-events", {
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
  });
  const calendarText = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:private-3",
    "DTSTART:20260903T170000",
    "DTEND:20260903T190000",
    "SUMMARY:Updated Concert",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:new-4",
    "DTSTART:20260905T100000",
    "DTEND:20260905T120000",
    "SUMMARY:Quartet Rehearsal",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const response = await fn.handler({
    httpMethod: "POST",
    body: JSON.stringify({ operation: "import_ics", calendarText, sourceName: "apple-calendar.ics" }),
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual({ imported: body.imported, updated: body.updated, skipped: body.skipped }, { imported: 1, updated: 1, skipped: 0 });
  assert.equal(store.state.events.length, 2);
  assert.equal(store.state.events.find((event) => event.uid === "private-3").id, 3);
  assert.equal(store.state.events.find((event) => event.uid === "new-4").private, true);
});

test("admin can export a combined schedule", async () => {
  const store = createStoreMock();
  const fn = loadFunction("../netlify/functions/calendar-events", {
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
  });

  const response = await fn.handler({ httpMethod: "GET", queryStringParameters: { format: "ics" } });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "text/calendar; charset=utf-8");
  assert.match(response.headers["Content-Disposition"], /studio-stage\.ics/);
  assert.match(response.body, /SUMMARY:Violin with Maya/);
  assert.match(response.body, /SUMMARY:Audition with Chicago Symphony/);
});

test("admin weekly calendar places a multi-day commitment on every covered date", async () => {
  const store = createStoreMock();
  store.state.events = [{
    id: 8,
    uid: "festival-8",
    title: "Summer festival",
    eventType: "concert",
    start: "2026-09-07",
    end: "2026-09-10",
    timezone: "America/Chicago",
    allDay: true,
    private: true,
  }];
  const schedule = require("../netlify/functions/_schedule");
  const week = {
    rangeStart: "2026-09-07T05:00:00Z",
    rangeEnd: "2026-09-14T05:00:00Z",
    timezone: "America/Chicago",
  };
  const fn = loadFunction("../netlify/functions/calendar-events", {
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
    "./_schedule": { ...schedule, currentStudioWeek() { return week; } },
  });

  const response = await fn.handler({ httpMethod: "GET" });
  const body = JSON.parse(response.body);

  assert.deepEqual(body.occurrences.map((event) => event.date), [
    "2026-09-07",
    "2026-09-08",
    "2026-09-09",
  ]);
});

test("admin calendar returns professional occurrences for the selected month", async () => {
  const store = createStoreMock();
  const fn = loadFunction("../netlify/functions/calendar-events", {
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
  });

  const response = await fn.handler({
    httpMethod: "GET",
    queryStringParameters: { month: "2026-09" },
  });
  const body = JSON.parse(response.body);

  assert.equal(body.month, "2026-09");
  assert.equal(body.occurrences.length, 1);
  assert.equal(body.occurrences[0].date, "2026-09-03");
});

test("manual professional events cannot overlap a lesson occurrence", async () => {
  const store = createStoreMock();
  const fn = loadFunction("../netlify/functions/calendar-events", {
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
  });

  const response = await fn.handler({
    httpMethod: "POST",
    body: JSON.stringify({
      operation: "save_event",
      event: {
        title: "Rehearsal",
        eventType: "rehearsal",
        start: "2026-09-02T16:30:00",
        end: "2026-09-02T17:30:00",
      },
    }),
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.match(JSON.parse(response.body).error, /Maya.*lesson/i);
  assert.equal(store.state.events.length, 1);
});

test("iCloud URL import rejects non-iCloud hosts before fetching", async () => {
  const store = createStoreMock();
  const fn = loadFunction("../netlify/functions/calendar-events", {
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
  });

  const response = await fn.handler({
    httpMethod: "POST",
    body: JSON.stringify({ operation: "import_url", url: "https://example.com/private.ics" }),
  });

  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /iCloud/i);
});

test("iCloud import rejects oversized responses before buffering", async () => {
  const store = createStoreMock();
  const fn = loadFunction("../netlify/functions/calendar-events", {
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
  });
  const originalFetch = global.fetch;
  let readBody = false;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get(name) { return name.toLowerCase() === "content-length" ? String(3 * 1024 * 1024) : null; } },
    async text() { readBody = true; return ""; },
  });

  try {
    const response = await fn.handler({
      httpMethod: "POST",
      body: JSON.stringify({ operation: "import_url", url: "webcal://p01-caldav.icloud.com/published/example" }),
    });
    assert.equal(response.statusCode, 413, response.body);
    assert.equal(readBody, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("malformed calendar import returns a validation error without overwriting events", async () => {
  const store = createStoreMock();
  const before = JSON.stringify(store.state.events);
  const fn = loadFunction("../netlify/functions/calendar-events", {
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
  });

  const response = await fn.handler({
    httpMethod: "POST",
    body: JSON.stringify({ operation: "import_ics", calendarText: "not a calendar" }),
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.match(JSON.parse(response.body).error, /valid iCalendar/i);
  assert.equal(JSON.stringify(store.state.events), before);
});

test("calendar management requires an admin session", async () => {
  const store = createStoreMock();
  const fn = loadFunction("../netlify/functions/calendar-events", {
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: false, reason: "forbidden", status: 403 }; } },
  });

  const response = await fn.handler({ httpMethod: "GET" });
  assert.equal(response.statusCode, 403);
});
