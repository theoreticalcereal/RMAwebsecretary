const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function withBlobMock(load) {
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
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
    return load();
  } finally {
    Module._load = originalLoad;
  }
}

function loadStore() {
  const storePath = require.resolve("../netlify/functions/_store");
  delete require.cache[storePath];
  return withBlobMock(() => require("../netlify/functions/_store"));
}

function loadReminderSettings(mocks = {}) {
  const fnPath = require.resolve("../netlify/functions/reminder-settings");
  delete require.cache[fnPath];

  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    const parentFile = String(parent?.filename || "");
    if (parentFile.endsWith("netlify/functions/reminder-settings.js") && mocks[request]) {
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
    return require("../netlify/functions/reminder-settings");
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

function createStoreMock(existing = {}) {
  const { normalizeReminderSettings } = loadStore();
  const state = {
    reminderSettings: { ...existing },
  };

  return {
    state,
    module: {
      getLessonStore() {
        return state;
      },
      async readReminderSettings(_store, userId) {
        return state.reminderSettings[userId] || { delivery: "email_calendar", offsetsMinutes: [60] };
      },
      async writeReminderSettings(_store, userId, settings) {
        const normalized = normalizeReminderSettings(settings);
        state.reminderSettings[userId] = normalized;
        return normalized;
      },
      jsonResponse,
    },
  };
}

test("normalizes reminder settings to supported delivery modes and offsets", () => {
  const { normalizeReminderSettings } = loadStore();
  assert.deepEqual(
    normalizeReminderSettings({
      delivery: "calendar",
      offsetsMinutes: [1440, 60, 60, -5, 999999],
    }),
    {
      delivery: "calendar",
      offsetsMinutes: [60, 1440],
    }
  );

  assert.deepEqual(normalizeReminderSettings({ delivery: "sms", offsetsMinutes: [] }), {
    delivery: "email_calendar",
    offsetsMinutes: [60],
  });
});

test("returns default reminder settings for signed-in users", async () => {
  const store = createStoreMock();
  const fn = loadReminderSettings({
    "./_store": store.module,
    "./_auth": {
      async getSession() {
        return { id: "user-1", email: "ricky@example.com" };
      },
    },
  });

  const response = await fn.handler({ httpMethod: "GET" });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(JSON.parse(response.body).settings, {
    delivery: "email_calendar",
    offsetsMinutes: [60],
  });
});

test("saves normalized reminder settings for signed-in users", async () => {
  const store = createStoreMock();
  const fn = loadReminderSettings({
    "./_store": store.module,
    "./_auth": {
      async getSession() {
        return { id: "user-1", email: "ricky@example.com" };
      },
    },
  });

  const response = await fn.handler({
    httpMethod: "POST",
    body: JSON.stringify({
      settings: {
        delivery: "calendar",
        offsetsMinutes: [1440, 60, 60, -5, 999999],
      },
    }),
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(JSON.parse(response.body).settings, {
    delivery: "calendar",
    offsetsMinutes: [60, 1440],
  });
  assert.deepEqual(store.state.reminderSettings["user-1"], {
    delivery: "calendar",
    offsetsMinutes: [60, 1440],
  });
});

test("rejects reminder settings requests without a session", async () => {
  const store = createStoreMock();
  const fn = loadReminderSettings({
    "./_store": store.module,
    "./_auth": {
      async getSession() {
        return null;
      },
    },
  });

  const response = await fn.handler({ httpMethod: "GET" });
  assert.equal(response.statusCode, 401, response.body);
});
