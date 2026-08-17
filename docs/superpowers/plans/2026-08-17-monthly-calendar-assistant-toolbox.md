# Monthly Calendar and Assistant Toolbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the musician workspace simpler, show the complete selected month, improve contextual assistant behavior, and move off-time lessons into the closest collision-free 15-minute slots without priority.

**Architecture:** Extend the existing schedule range utilities and Netlify endpoints instead of adding dependencies. The admin client owns month navigation and rendering; the backend expands lesson and professional occurrences for the requested month. The assistant keeps its validated mutation boundary but exposes a clearer scheduling-tool catalog and returns contextual clarification instead of canned authorization copy.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Node.js Netlify Functions, `node:test`, Netlify Blobs.

## Global Constraints

- Only the musician combined calendar changes to monthly; the student calendar remains weekly.
- Student-visible professional events remain `Unavailable` only.
- Calendar cards state `Recurring` or `One-time`.
- Off-time resolution stays on the same weekday, uses 15-minute candidates on both sides, shuffles affected lessons, and reserves proposed slots.
- No new runtime dependency.

---

### Task 1: Month-range schedule API

**Files:**
- Modify: `netlify/functions/_schedule.js`
- Modify: `netlify/functions/admin-lessons.js`
- Modify: `netlify/functions/calendar-events.js`
- Test: `test/schedule.test.js`
- Test: `test/calendar-api.test.js`

**Interfaces:**
- Produces: `studioMonth({ month, timezone }) -> { rangeStart, rangeEnd, timezone, month }`.
- Consumes: optional `month=YYYY-MM` query parameter on admin calendar GET endpoints.

- [ ] Write failing tests proving a selected month includes recurring lessons and professional events outside the current week.
- [ ] Run the focused schedule/API tests and confirm the new assertions fail.
- [ ] Implement validated month ranges and return month-expanded occurrences.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Monthly musician calendar and simplified copy

**Files:**
- Modify: `public/index.html`
- Modify: `public/admin/index.html`

**Interfaces:**
- Consumes: month-expanded `lessonOccurrences` and professional `occurrences`.
- Produces: previous/current/next month controls and a 7-column month grid with recurrence labels.

- [ ] Add static frontend assertions for compact banner copy, removed verbose assistant copy, monthly controls, and recurrence labels.
- [ ] Run the frontend assertions and confirm they fail.
- [ ] Shrink the public banner, simplify descriptions, and replace the combined weekly renderer with a monthly grid.
- [ ] Parse both inline scripts and verify unique static IDs.

### Task 3: Contextual scheduling toolbox

**Files:**
- Modify: `netlify/functions/assistant.js`
- Modify: `public/index.html`
- Modify: `public/admin/index.html`
- Test: `test/assistant-defaults.test.js`

**Interfaces:**
- Produces: a scheduling-tool catalog in the model prompt and a rolling 12-message client context.
- Behavior: incomplete but explicit mutations keep the model's natural clarification and never receive the canned “explicitly ask” response.

- [ ] Add failing tests for “I need to reschedule my next lesson” and the scheduling-tool prompt catalog.
- [ ] Run the assistant tests and confirm the failure is caused by the authorization-response override.
- [ ] Separate explicit intent from complete mutation arguments, preserve safe validation, and return natural contextual clarification for incomplete calls.
- [ ] Expand both clients to a 12-message rolling context and rerun assistant tests.

### Task 4: Closest-slot off-time resolution

**Files:**
- Modify: `netlify/functions/admin-lessons.js`
- Test: `test/admin-offtime.test.js`

**Interfaces:**
- Produces: shuffled affected-lesson processing and nearest same-weekday 15-minute candidates before/after the window.
- Reserves: existing lessons plus slots proposed earlier in the same resolution run.

- [ ] Add failing tests for a closer pre-window slot, 15-minute alignment, and proposal collision avoidance.
- [ ] Run the focused tests and confirm current forward-only logic fails.
- [ ] Implement shuffled processing, distance-ranked candidates, and proposal reservations.
- [ ] Run the focused tests and confirm they pass.

### Task 5: Verification

**Files:**
- Verify all modified files.

- [ ] Run `node --test test/*.test.js` and require zero failures.
- [ ] Run `node --check` for all JavaScript files.
- [ ] Parse both HTML inline scripts and verify unique IDs.
- [ ] Run `git diff --check`.
