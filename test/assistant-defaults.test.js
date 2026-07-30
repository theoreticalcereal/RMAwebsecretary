const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadAssistant(mocks = {}) {
  const assistantPath = require.resolve("../netlify/functions/assistant");
  delete require.cache[assistantPath];

  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    const parentFile = String(parent?.filename || "");
    if (parentFile.endsWith("netlify/functions/assistant.js") && mocks[request]) {
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
    return require("../netlify/functions/assistant");
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

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return h * 60 + m;
}

function timesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = toMinutes(aStart);
  const ae = toMinutes(aEnd);
  const bs = toMinutes(bStart);
  const be = toMinutes(bEnd);
  return as < be && bs < ae;
}

function createStoreMock(initialLessons, options = {}) {
  const state = {
    lessons: initialLessons.map((lesson) => ({ ...lesson })),
    usage: { count: 0, maintainerNotified: false },
    pendingChanges: (options.pendingChanges || []).map((change) => JSON.parse(JSON.stringify(change))),
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
      async readApprovalSettings() {
        return {
          mode: "automatic",
          auto: {
            minHoursBefore: 24,
            requireReason: true,
            minReasonLength: 10,
          },
        };
      },
      async readPendingChanges() {
        return state.pendingChanges;
      },
      async writePendingChanges(_store, changes) {
        state.pendingChanges = changes;
      },
      filterPendingChangesForUser(changes) {
        return changes;
      },
      RESOLVED_REQUEST_TTL_HOURS: 24,
      async recordUserIdentity() {},
      async readUsage() {
        return state.usage;
      },
      async writeUsage(_store, _userId, usage) {
        state.usage = usage;
      },
      async getUserPromptLimit() {
        return 5;
      },
      async canConsumeNimRequestSlot() {
        return { allowed: true, retryAfterMs: 0 };
      },
      NIM_RATE_LIMIT_PER_WINDOW: 40,
      NIM_RATE_WINDOW_MS: 60000,
      jsonResponse,
      nextId(items) {
        return items.length ? Math.max(...items.map((item) => item.id)) + 1 : 1;
      },
      timesOverlap,
    },
  };
}

test("uses Netlify-safe defaults for AI reasoning allocation", () => {
  const assistant = loadAssistant();
  assert.deepEqual(assistant.__test.aiDefaults, {
    requestTimeoutMs: 9000,
    reasonTimeoutMs: 9000,
    maxTokens: 1536,
    reasonMaxTokens: 256,
  });
});

test("reschedules a lesson from subject, student, day, and bare old time", async () => {
  const store = createStoreMock([
    {
      id: 7,
      student: "Ricky",
      subject: "Cello",
      day_of_week: 6,
      start_time: "18:30",
      end_time: "19:30",
      recurring: true,
      specific_date: null,
      active: true,
    },
  ]);

  const assistant = loadAssistant({
    "./_store": store.module,
    "./_auth": {
      async getSession() {
        return { id: "user-1", email: "ricky@example.com" };
      },
    },
    "./_notify": {
      async notifyMaintainer() {
        return { sent: false };
      },
    },
  });

  const response = await assistant.handler({
    httpMethod: "POST",
    body: JSON.stringify({
      message:
        "Can you reschedule cello with ricky at 6:30 on sunday to 2:00 pm so that I can go to my siblings wedding",
    }),
  });

  assert.equal(response.statusCode, 201, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.applied, true);
  assert.equal(body.lesson.id, 7);
  assert.equal(body.lesson.start_time, "14:00");
  assert.equal(body.lesson.end_time, "15:00");
  assert.equal(body.action.lesson_id, 7);
  assert.equal(body.action.reason, "I can go to my siblings wedding");
});

test("lets AI use pending request context to add a follow-up reason", async () => {
  const store = createStoreMock([], {
    pendingChanges: [
      {
        id: 12,
        status: "pending",
        createdAt: "2026-07-30T17:54:00.000Z",
        requestedBy: "user-1",
        requestedByEmail: "ricky@example.com",
        requestMessage: "Can you add Cello with Samuel from 7:00 to 8:00 PM on friday",
        autoCheck: {
          requiredReason: "",
        },
        action: {
          action: "add",
          student: "Samuel",
          subject: "Cello",
          day_of_week: 4,
          start_time: "19:00",
          end_time: "20:00",
          old_start_time: null,
          old_end_time: null,
          recurring: true,
          specific_date: null,
          lesson_id: null,
          reason: null,
          reply: "A valid reason is required before automatic approval.",
        },
      },
    ],
  });

  const originalFetch = global.fetch;
  const originalApiKey = process.env.NVIDIA_NIM_API_KEY;
  let nimPrompt = "";
  process.env.NVIDIA_NIM_API_KEY = "test-key";
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    nimPrompt = payload.messages.find((message) => message.role === "user").content;
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "add",
                  student: "Samuel",
                  subject: "Cello",
                  day_of_week: 4,
                  start_time: "19:00",
                  end_time: "20:00",
                  old_start_time: null,
                  old_end_time: null,
                  recurring: true,
                  specific_date: null,
                  lesson_id: null,
                  reason: "its the scheduled weekly class and hasn't been added to calendar yet",
                  reply: "I found the pending Cello with Samuel request and added that reason.",
                }),
              },
            },
          ],
        };
      },
    };
  };

  try {
    const assistant = loadAssistant({
      "./_store": store.module,
      "./_auth": {
        async getSession() {
          return { id: "user-1", email: "ricky@example.com" };
        },
      },
      "./_notify": {
        async notifyMaintainer() {
          return { sent: false };
        },
      },
    });

    const response = await assistant.handler({
      httpMethod: "POST",
      body: JSON.stringify({
        message: "its the scheduled weekly class and hasn't been added to calendar yet",
      }),
    });

    assert.match(nimPrompt, /PENDING REQUESTS:/);
    assert.match(nimPrompt, /id=12/);
    assert.match(nimPrompt, /Cello/);
    assert.match(nimPrompt, /Samuel/);
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.applied, false);
    assert.equal(body.pending, true);
    assert.equal(body.pendingChange.id, 12);
    assert.equal(
      body.pendingChange.autoCheck.requiredReason,
      "its the scheduled weekly class and hasn't been added to calendar yet"
    );
    assert.equal(
      body.pendingChange.action.reason,
      "its the scheduled weekly class and hasn't been added to calendar yet"
    );
    assert.equal(store.state.lessons.length, 0);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.NVIDIA_NIM_API_KEY;
    } else {
      process.env.NVIDIA_NIM_API_KEY = originalApiKey;
    }
  }
});

test("lets AI reason over an approval follow-up with pending request context", async () => {
  const existingReason = "Its the weekly occuring lesson it hasnt been added yet";
  const store = createStoreMock([], {
    pendingChanges: [
      {
        id: 13,
        status: "pending",
        createdAt: "2026-07-30T17:56:00.000Z",
        requestedBy: "user-1",
        requestedByEmail: "ricky@example.com",
        requestMessage: "Can you add Cello with Samuel from 7:00 to 8:00 PM on friday",
        autoCheck: {
          requiredReason: existingReason,
        },
        action: {
          action: "add",
          student: "Samuel",
          subject: "Cello",
          day_of_week: 4,
          start_time: "19:00",
          end_time: "20:00",
          old_start_time: null,
          old_end_time: null,
          recurring: true,
          specific_date: null,
          lesson_id: null,
          reason: existingReason,
          reply: "A valid reason is required before automatic approval.",
        },
      },
    ],
  });

  const originalFetch = global.fetch;
  const originalApiKey = process.env.NVIDIA_NIM_API_KEY;
  let nimPrompt = "";
  process.env.NVIDIA_NIM_API_KEY = "test-key";
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    nimPrompt = payload.messages.find((message) => message.role === "user").content;
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "query",
                  student: null,
                  subject: null,
                  day_of_week: null,
                  start_time: null,
                  end_time: null,
                  old_start_time: null,
                  old_end_time: null,
                  recurring: true,
                  specific_date: null,
                  lesson_id: null,
                  reason: null,
                  reply: "I found your pending Cello with Samuel request. It still needs maintainer review.",
                }),
              },
            },
          ],
        };
      },
    };
  };

  try {
    const assistant = loadAssistant({
      "./_store": store.module,
      "./_auth": {
        async getSession() {
          return { id: "user-1", email: "ricky@example.com" };
        },
      },
      "./_notify": {
        async notifyMaintainer() {
          return { sent: false };
        },
      },
    });

    const response = await assistant.handler({
      httpMethod: "POST",
      body: JSON.stringify({
        message: "Can you approve it",
      }),
    });

    assert.match(nimPrompt, /PENDING REQUESTS:/);
    assert.match(nimPrompt, /id=13/);
    assert.match(nimPrompt, /Cello/);
    assert.match(nimPrompt, /Samuel/);
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.applied, false);
    assert.equal(body.pending, undefined);
    assert.match(body.action.reply, /pending Cello with Samuel request/i);
    assert.equal(store.state.pendingChanges[0].autoCheck.requiredReason, existingReason);
    assert.equal(store.state.pendingChanges[0].action.reason, existingReason);
    assert.equal(store.state.lessons.length, 0);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.NVIDIA_NIM_API_KEY;
    } else {
      process.env.NVIDIA_NIM_API_KEY = originalApiKey;
    }
  }
});
