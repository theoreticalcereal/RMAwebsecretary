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

function createAdminStoreMock() {
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
});

test("saving off-time automatically proposes reschedules and emails affected users", async () => {
  const store = createAdminStoreMock();
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
  assert.equal(body.proposedReschedules.length, 1);
  assert.equal(body.proposedReschedules[0].lessonId, 1);
  assert.equal(body.proposedReschedules[0].email.sent, true);
  assert.equal(store.state.pendingChanges.length, 1);
  assert.equal(store.state.pendingChanges[0].source, "off-time-renegotiation");
  assert.equal(store.state.pendingChanges[0].requestedByEmail, "ricky@example.com");
  assert.equal(store.state.pendingChanges[0].action.action, "reschedule");
  assert.equal(store.state.pendingChanges[0].action.lesson_id, 1);
  assert.equal(store.state.pendingChanges[0].action.start_time, "15:30");
  assert.equal(store.state.pendingChanges[0].action.end_time, "16:30");
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, "ricky@example.com");
  assert.equal(emails[0].proposedAction.start_time, "15:30");
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
