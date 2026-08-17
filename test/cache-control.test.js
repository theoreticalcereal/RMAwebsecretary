const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadStoreWithoutNetlifyRuntime() {
  const storePath = require.resolve("../netlify/functions/_store");
  delete require.cache[storePath];
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "@netlify/blobs") {
      return { connectLambda() {}, getStore() { return {}; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../netlify/functions/_store");
  } finally {
    Module._load = originalLoad;
  }
}

test("JSON API responses prevent stale schedule caching", () => {
  const { jsonResponse } = loadStoreWithoutNetlifyRuntime();
  const response = jsonResponse(200, { busyOccurrences: [] });

  assert.equal(response.headers["Cache-Control"], "no-store, no-cache, must-revalidate");
  assert.equal(response.headers.Pragma, "no-cache");
  assert.equal(response.headers.Expires, "0");
});
