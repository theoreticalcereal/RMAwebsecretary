const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicHtml = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(__dirname, "../public/admin/index.html"), "utf8");

test("student banner is compact and uses simple scheduling copy", () => {
  assert.match(publicHtml, /<h1>Lesson schedule<\/h1>/);
  assert.match(publicHtml, /Book, change, or check a lesson time\./);
  assert.doesNotMatch(publicHtml, /Your lesson schedule, in tune/);
  assert.match(publicHtml, /main \{ margin-top: -24px; \}/);
});

test("musician workspace has monthly calendar controls and recurrence labels", () => {
  assert.match(adminHtml, /id="calendar-prev-month"/);
  assert.match(adminHtml, /id="calendar-today"/);
  assert.match(adminHtml, /id="calendar-next-month"/);
  assert.match(adminHtml, /id="calendar-month-label"/);
  assert.match(adminHtml, /Combined calendar/);
  assert.match(adminHtml, /Recurring/);
  assert.match(adminHtml, /One-time/);
  assert.doesNotMatch(adminHtml, /Combined weekly calendar/);
});

test("workspace descriptions stay concise", () => {
  assert.doesNotMatch(adminHtml, /Create or move concerts, rehearsals, blocked time, and lessons using plain language/);
  assert.doesNotMatch(adminHtml, /Scheduling only—no practice or artistic coaching/);
  assert.match(adminHtml, /Import \.ics or refresh iCloud\./);
});
