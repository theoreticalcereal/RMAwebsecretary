const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

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

const assistant = require("../netlify/functions/assistant");
Module._load = originalLoad;

test("uses Netlify-safe defaults for AI reasoning allocation", () => {
  assert.deepEqual(assistant.__test.aiDefaults, {
    requestTimeoutMs: 9000,
    reasonTimeoutMs: 9000,
    maxTokens: 1536,
    reasonMaxTokens: 256,
  });
});
