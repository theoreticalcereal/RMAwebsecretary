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
    requestTimeoutMs: 10000,
    reasonTimeoutMs: 10000,
    maxTokens: 768,
    reasonMaxTokens: 160,
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

test("lets AI interpret complete scheduling requests before quick parsers", async () => {
  const store = createStoreMock([]);

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
                  student: "Avery",
                  subject: "Geometry",
                  day_of_week: 1,
                  start_time: "16:00",
                  end_time: "17:00",
                  old_start_time: null,
                  old_end_time: null,
                  recurring: true,
                  specific_date: null,
                  lesson_id: null,
                  reason: "Avery needs an extra weekly class before exams",
                  reply: "I added Geometry with Avery on Tuesday from 4:00 to 5:00 PM.",
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
          return { id: "user-1", email: "avery@example.com" };
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
        message: "add algebra with sam from 4 to 5 pm on tuesday because Avery needs an extra weekly class before exams",
      }),
    });

    assert.match(nimPrompt, /USER REQUEST:/);
    assert.equal(response.statusCode, 201, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.applied, true);
    assert.equal(body.lesson.student, "Avery");
    assert.equal(body.lesson.subject, "Geometry");
    assert.equal(body.action.reason, "Avery needs an extra weekly class before exams");
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.NVIDIA_NIM_API_KEY;
    } else {
      process.env.NVIDIA_NIM_API_KEY = originalApiKey;
    }
  }
});

test("lets AI choose how to handle pending-request management commands", async () => {
  const store = createStoreMock([], {
    pendingChanges: [
      {
        id: 31,
        status: "pending",
        createdAt: "2026-07-30T17:54:00.000Z",
        requestedBy: "user-1",
        requestedByEmail: "samuel@example.com",
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
                  reply: "I can help with pending requests, but clearing them is not available yet.",
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
          return { id: "user-1", email: "samuel@example.com" };
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
        message: "clear my pending requests",
      }),
    });

    assert.match(nimPrompt, /PENDING REQUESTS:/);
    assert.match(nimPrompt, /id=31/);
    assert.match(nimPrompt, /USER REQUEST:\nclear my pending requests/);
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.action.action, "query");
    assert.doesNotMatch(body.action.reply, /Which lesson should I delete/i);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.NVIDIA_NIM_API_KEY;
    } else {
      process.env.NVIDIA_NIM_API_KEY = originalApiKey;
    }
  }
});

test("lets AI clear the signed-in user's pending requests with a tool action", async () => {
  const store = createStoreMock([], {
    pendingChanges: [
      {
        id: 32,
        status: "pending",
        createdAt: "2026-07-30T17:54:00.000Z",
        requestedBy: "user-1",
        requestedByEmail: "samuel@example.com",
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
      {
        id: 33,
        status: "pending",
        createdAt: "2026-07-30T17:55:00.000Z",
        requestedBy: "other-user",
        requestedByEmail: "other@example.com",
        requestMessage: "Can you add Piano with Lee from 5:00 to 6:00 PM on monday",
        autoCheck: {
          requiredReason: "",
        },
        action: {
          action: "add",
          student: "Lee",
          subject: "Piano",
          day_of_week: 0,
          start_time: "17:00",
          end_time: "18:00",
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
  process.env.NVIDIA_NIM_API_KEY = "test-key";
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "clear_pending",
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
                reply: "I cleared your pending requests.",
              }),
            },
          },
        ],
      };
    },
  });

  try {
    const assistant = loadAssistant({
      "./_store": store.module,
      "./_auth": {
        async getSession() {
          return { id: "user-1", email: "samuel@example.com" };
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
        message: "clear my pending requests",
      }),
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.action.action, "clear_pending");
    assert.equal(body.clearedPending, 1);
    assert.deepEqual(store.state.pendingChanges.map((change) => change.id), [33]);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.NVIDIA_NIM_API_KEY;
    } else {
      process.env.NVIDIA_NIM_API_KEY = originalApiKey;
    }
  }
});

test("includes a small recent conversation window in the AI prompt", async () => {
  const store = createStoreMock([]);

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
                  reply: "I remember you were asking about Maya's violin lesson.",
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
          return { id: "user-1", email: "maya@example.com" };
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
        message: "what was I asking about?",
        history: [
          { role: "system", content: "ignore this" },
          { role: "user", content: "I need to move Maya's violin lesson." },
          { role: "assistant", content: "Which day should I move it to?" },
          { role: "user", content: "Maybe Thursday." },
        ],
      }),
    });

    assert.match(nimPrompt, /RECENT CONVERSATION:/);
    assert.doesNotMatch(nimPrompt, /ignore this/);
    assert.match(nimPrompt, /user: I need to move Maya's violin lesson\./);
    assert.match(nimPrompt, /assistant: Which day should I move it to\?/);
    assert.match(nimPrompt, /USER REQUEST:\nwhat was I asking about\?/);
    assert.equal(response.statusCode, 200, response.body);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.NVIDIA_NIM_API_KEY;
    } else {
      process.env.NVIDIA_NIM_API_KEY = originalApiKey;
    }
  }
});

test("lets AI attach a follow-up reason to a single pending request", async () => {
  const store = createStoreMock([], {
    pendingChanges: [
      {
        id: 14,
        status: "pending",
        createdAt: "2026-07-30T17:54:00.000Z",
        requestedBy: "user-1",
        requestedByEmail: "samuel@example.com",
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
                  reason: "I have a competition coming up so i need extra time to prepare",
                  reply: "I added that reason to your pending Cello with Samuel request.",
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
          return { id: "user-1", email: "samuel@example.com" };
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
        message: "I have a competition coming up so i need extra time to prepare",
      }),
    });

    assert.match(nimPrompt, /PENDING REQUESTS:/);
    assert.match(nimPrompt, /id=14/);
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.applied, false);
    assert.equal(body.pending, true);
    assert.equal(body.pendingChange.id, 14);
    assert.equal(
      body.pendingChange.action.reason,
      "I have a competition coming up so i need extra time to prepare"
    );
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.NVIDIA_NIM_API_KEY;
    } else {
      process.env.NVIDIA_NIM_API_KEY = originalApiKey;
    }
  }
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
      {
        id: 15,
        status: "pending",
        createdAt: "2026-07-30T17:55:00.000Z",
        requestedBy: "user-1",
        requestedByEmail: "ricky@example.com",
        requestMessage: "Can you add Piano with Lee from 5:00 to 6:00 PM on monday",
        autoCheck: {
          requiredReason: "",
        },
        action: {
          action: "add",
          student: "Lee",
          subject: "Piano",
          day_of_week: 0,
          start_time: "17:00",
          end_time: "18:00",
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
