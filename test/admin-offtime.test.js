const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadAdminLessons(mocks = {}) {
  const adminPath = require.resolve("../netlify/functions/admin-lessons");
  delete require.cache[adminPath];

  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    const parentFile = String(parent?.filename || "");
    if (parentFile.endsWith("netlify/functions/admin-lessons.js") && mocks[request]) {
      return mocks[request];
    }
    if (request === "@netlify/blobs") {
      return {
        connectLambda() {},
        getStore() {
          return {};
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../netlify/functions/admin-lessons");
  } finally {
    Module._load = originalLoad;
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function timesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function createAdminStoreMock() {
  const defaultWorkingHours = () => [
    { day_of_week: 0, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 1, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 2, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 3, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 4, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 5, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 6, enabled: true, start_time: "09:00", end_time: "20:00" },
  ];
  const state = {
    lessons: [
      {
        id: 1,
        student: "Ricky",
        subject: "Cello",
        day_of_week: 4,
        start_time: "14:00",
        end_time: "15:00",
        recurring: true,
        specific_date: null,
        active: true,
        requestedBy: "user-1",
        requestedByEmail: "ricky@example.com",
      },
      {
        id: 2,
        student: "Maya",
        subject: "Violin",
        day_of_week: 4,
        start_time: "17:00",
        end_time: "18:00",
        recurring: true,
        specific_date: null,
        active: true,
      },
    ],
    offTimeWindows: [],
    pendingChanges: [],
    workingHours: null,
  };

  return {
    state,
    module: {
      getLessonStore() {
        return state;
      },
      async readLessons() {
        return state.lessons;
      },
      async writeLessons(_store, lessons) {
        state.lessons = lessons;
      },
      async readExceptions() {
        return [];
      },
      async writeExceptions() {},
      async getUsageSettings() {
        return { defaultDailyPromptLimit: 5 };
      },
      async writeUsageSettings() {},
      async setUserPromptLimit() {
        return 5;
      },
      async resetUserPromptLimit() {
        return 5;
      },
      async resetUserUsage() {
        return { userId: "user-1", count: 0, maintainerNotified: false };
      },
      async resetAllUsage() {},
      async readApprovalSettings() {
        return { mode: "manual", auto: { minHoursBefore: 24, requireReason: true, minReasonLength: 10 } };
      },
      async writeApprovalSettings() {},
      async readPendingChanges() {
        return state.pendingChanges;
      },
      async writePendingChanges(_store, changes) {
        state.pendingChanges = changes;
      },
      filterVisiblePendingChanges(changes) {
        return changes;
      },
      async readUserIdentityMap() {
        return {};
      },
      async updateUserIdentity() {
        return null;
      },
      async listTodayUsage() {
        return [];
      },
      async readOffTimeWindows() {
        return state.offTimeWindows;
      },
      async writeOffTimeWindows(_store, windows) {
        state.offTimeWindows = windows;
      },
      async readWorkingHours() {
        return state.workingHours || defaultWorkingHours();
      },
      async writeWorkingHours(_store, hours) {
        const defaults = defaultWorkingHours();
        const byDay = new Map((Array.isArray(hours) ? hours : []).map((entry) => [Number(entry.day_of_week), entry]));
        state.workingHours = defaults.map((fallback) => ({
          ...fallback,
          ...(byDay.get(fallback.day_of_week) || {}),
        }));
        return state.workingHours;
      },
      jsonResponse,
      nextId(items) {
        return items.length ? Math.max(...items.map((item) => item.id)) + 1 : 1;
      },
      timesOverlap(aStart, aEnd, bStart, bEnd) {
        return aStart < bEnd && bStart < aEnd;
      },
    },
  };
}

test("admin can save off-time windows and see affected lessons", async () => {
  const store = createAdminStoreMock();
  const admin = loadAdminLessons({
    "./_store": store.module,
    "./_auth": {
      async getAdminSession() {
        return { ok: true, user: { email: "admin@example.com" } };
      },
    },
    "./_notify": {
      async sendOffTimeProposalEmail() {
        return { sent: false, reason: "test noop" };
      },
    },
  });

  const response = await admin.handler({
    httpMethod: "POST",
    body: JSON.stringify({
      operation: "save_offtime_window",
      window: {
        kind: "weekly",
        day_of_week: 4,
        start_time: "13:30",
        end_time: "15:30",
        note: "Studio closed",
      },
    }),
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.offTimeWindow.id, 1);
  assert.equal(body.affectedLessons.length, 1);
  assert.equal(body.affectedLessons[0].student, "Ricky");
  assert.equal(store.state.offTimeWindows.length, 1);
  assert.equal(store.state.pendingChanges.length, 0);
});

test("admin lesson calendar expands the selected month", async () => {
  const store = createAdminStoreMock();
  const admin = loadAdminLessons({
    "./_store": store.module,
    "./_auth": {
      async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; },
    },
    "./_notify": { async sendOffTimeProposalEmail() { return { sent: false }; } },
  });

  const response = await admin.handler({
    httpMethod: "GET",
    queryStringParameters: { month: "2026-09" },
  });
  const body = JSON.parse(response.body);

  assert.equal(body.month, "2026-09");
  assert.equal(body.lessonOccurrences.length, 8);
  assert.ok(body.lessonOccurrences.every((lesson) => lesson.occurrenceDate.startsWith("2026-09-")));
});

test("admin can save weekly working hours", async () => {
  const store = createAdminStoreMock();
  const admin = loadAdminLessons({
    "./_store": store.module,
    "./_auth": {
      async getAdminSession() {
        return { ok: true, user: { email: "admin@example.com" } };
      },
    },
    "./_notify": {
      async sendOffTimeProposalEmail() {
        return { sent: false, reason: "test noop" };
      },
    },
  });

  const response = await admin.handler({
    httpMethod: "POST",
    body: JSON.stringify({
      operation: "save_working_hours",
      workingHours: [
        { day_of_week: 4, enabled: true, start_time: "10:00", end_time: "18:00" },
        { day_of_week: 5, enabled: false, start_time: "09:00", end_time: "20:00" },
      ],
    }),
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.workingHours.length, 7);
  assert.deepEqual(body.workingHours[4], {
    day_of_week: 4,
    enabled: true,
    start_time: "10:00",
    end_time: "18:00",
  });
  assert.equal(body.workingHours[5].enabled, false);
});

test("auto-resolve off-time proposes reschedules inside working hours and emails users", async () => {
  const store = createAdminStoreMock();
  store.state.offTimeWindows = [
    { id: 3, kind: "weekly", day_of_week: 4, start_time: "13:30", end_time: "15:30", note: "Studio closed" },
  ];
  store.state.workingHours = [
    { day_of_week: 0, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 1, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 2, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 3, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 4, enabled: true, start_time: "10:00", end_time: "17:00" },
    { day_of_week: 5, enabled: true, start_time: "09:00", end_time: "20:00" },
    { day_of_week: 6, enabled: true, start_time: "09:00", end_time: "20:00" },
  ];
  const emails = [];
  const admin = loadAdminLessons({
    "./_store": store.module,
    "./_auth": {
      async getAdminSession() {
        return { ok: true, user: { email: "admin@example.com" } };
      },
    },
    "./_notify": {
      async sendOffTimeProposalEmail(payload) {
        emails.push(payload);
        return { sent: true };
      },
    },
  });

  const response = await admin.handler({
    httpMethod: "POST",
    body: JSON.stringify({
      operation: "auto_resolve_offtime",
      id: 3,
    }),
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.proposedReschedules.length, 1);
  assert.equal(body.proposedReschedules[0].lessonId, 1);
  assert.equal(body.proposedReschedules[0].email.sent, true);
  assert.equal(store.state.pendingChanges.length, 1);
  assert.equal(store.state.pendingChanges[0].source, "off-time-renegotiation");
  assert.equal(store.state.pendingChanges[0].requestedByEmail, "ricky@example.com");
  assert.equal(store.state.pendingChanges[0].action.action, "reschedule");
  assert.equal(store.state.pendingChanges[0].action.lesson_id, 1);
  assert.ok(["12:30", "15:30"].includes(store.state.pendingChanges[0].action.start_time));
  assert.ok(["13:30", "16:30"].includes(store.state.pendingChanges[0].action.end_time));
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, "ricky@example.com");
  assert.equal(emails[0].proposedAction.start_time, store.state.pendingChanges[0].action.start_time);
});

test("auto-resolve considers 15-minute candidate times", async () => {
  const store = createAdminStoreMock();
  store.state.lessons.push(
    { id: 3, student: "Before", day_of_week: 4, start_time: "10:00", end_time: "13:30", recurring: true, active: true },
    { id: 4, student: "Buffer", day_of_week: 4, start_time: "15:30", end_time: "15:45", recurring: true, active: true },
  );
  store.state.offTimeWindows = [
    { id: 5, kind: "weekly", day_of_week: 4, start_time: "13:30", end_time: "15:30", note: "Studio closed" },
  ];
  store.state.workingHours = [
    { day_of_week: 4, enabled: true, start_time: "10:00", end_time: "16:45" },
  ];
  const admin = loadAdminLessons({
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
    "./_notify": { async sendOffTimeProposalEmail() { return { sent: false }; } },
  });

  const response = await admin.handler({
    httpMethod: "POST",
    body: JSON.stringify({ operation: "auto_resolve_offtime", id: 5 }),
  });
  const proposal = JSON.parse(response.body).proposedReschedules.find((item) => item.lessonId === 1);

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(proposal.pendingChange.action.start_time, "15:45");
  assert.equal(proposal.pendingChange.action.end_time, "16:45");
});

test("auto-resolve shuffles affected lessons and reserves each proposed slot", async () => {
  const store = createAdminStoreMock();
  store.state.lessons.push({
    id: 3,
    student: "Noah",
    subject: "Piano",
    day_of_week: 4,
    start_time: "13:45",
    end_time: "14:30",
    recurring: true,
    active: true,
  });
  store.state.offTimeWindows = [
    { id: 6, kind: "weekly", day_of_week: 4, start_time: "13:30", end_time: "15:30", note: "Studio closed" },
  ];
  store.state.workingHours = [
    { day_of_week: 4, enabled: true, start_time: "10:00", end_time: "17:00" },
  ];
  const admin = loadAdminLessons({
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
    "./_notify": { async sendOffTimeProposalEmail() { return { sent: false }; } },
  });
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const response = await admin.handler({
      httpMethod: "POST",
      body: JSON.stringify({ operation: "auto_resolve_offtime", id: 6 }),
    });
    const proposals = JSON.parse(response.body).proposedReschedules.filter((item) => !item.skipped);
    const first = proposals[0].pendingChange.action;
    const second = proposals[1].pendingChange.action;

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(proposals[0].lessonId, 3);
    assert.equal(proposals.length, 2);
    assert.equal(timesOverlap(first.start_time, first.end_time, second.start_time, second.end_time), false);
  } finally {
    Math.random = originalRandom;
  }
});

test("off-time proposals remain approvable when lessons partly extend outside the window", async () => {
  const store = createAdminStoreMock();
  store.state.lessons = [
    { id: 1, student: "Early", day_of_week: 4, start_time: "13:30", end_time: "14:30", recurring: true, active: true },
    { id: 2, student: "Late", day_of_week: 4, start_time: "14:30", end_time: "15:30", recurring: true, active: true },
  ];
  store.state.offTimeWindows = [
    { id: 7, kind: "weekly", day_of_week: 4, start_time: "14:00", end_time: "15:00", note: "Studio closed" },
  ];
  store.state.workingHours = [
    { day_of_week: 4, enabled: true, start_time: "10:00", end_time: "18:00" },
  ];
  const admin = loadAdminLessons({
    "./_store": store.module,
    "./_auth": { async getAdminSession() { return { ok: true, user: { email: "admin@example.com" } }; } },
    "./_notify": { async sendOffTimeProposalEmail() { return { sent: false }; } },
  });

  const proposalResponse = await admin.handler({
    httpMethod: "POST",
    body: JSON.stringify({ operation: "auto_resolve_offtime", id: 7 }),
  });
  const proposals = JSON.parse(proposalResponse.body).proposedReschedules.filter((item) => !item.skipped);
  assert.equal(proposals.length, 2, proposalResponse.body);

  for (const proposal of proposals) {
    const approvalResponse = await admin.handler({
      httpMethod: "POST",
      body: JSON.stringify({ operation: "approve_change", id: proposal.pendingChange.id }),
    });
    assert.equal(approvalResponse.statusCode, 200, approvalResponse.body);
  }
});

test("admin off-time rejects date-specific windows because schedule is weekly-only", async () => {
  const store = createAdminStoreMock();
  const admin = loadAdminLessons({
    "./_store": store.module,
    "./_auth": {
      async getAdminSession() {
        return { ok: true, user: { email: "admin@example.com" } };
      },
    },
    "./_notify": {
      async sendOffTimeProposalEmail() {
        return { sent: false, reason: "test noop" };
      },
    },
  });

  const response = await admin.handler({
    httpMethod: "POST",
    body: JSON.stringify({
      operation: "save_offtime_window",
      window: {
        kind: "dated",
        specific_date: "2026-09-04",
        start_time: "13:30",
        end_time: "15:30",
      },
    }),
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.match(JSON.parse(response.body).error, /weekly-only/i);
  assert.equal(store.state.offTimeWindows.length, 0);
  assert.equal(store.state.pendingChanges.length, 0);
});

test("admin can delete off-time windows", async () => {
  const store = createAdminStoreMock();
  store.state.offTimeWindows = [
    { id: 4, kind: "weekly", day_of_week: 4, start_time: "13:30", end_time: "15:30", note: "Studio closed" },
  ];
  const admin = loadAdminLessons({
    "./_store": store.module,
    "./_auth": {
      async getAdminSession() {
        return { ok: true, user: { email: "admin@example.com" } };
      },
    },
    "./_notify": {
      async sendOffTimeProposalEmail() {
        return { sent: false, reason: "test noop" };
      },
    },
  });

  const response = await admin.handler({
    httpMethod: "POST",
    body: JSON.stringify({ operation: "delete_offtime_window", id: 4 }),
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(JSON.parse(response.body).deleted, 4);
  assert.deepEqual(store.state.offTimeWindows, []);
});
