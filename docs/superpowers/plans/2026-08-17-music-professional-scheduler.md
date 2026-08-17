# Music Professional Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished, role-aware music scheduling workspace with private professional events and Apple Calendar `.ics` import/export.

**Architecture:** Keep lessons and their approval workflow intact, add a focused calendar-event store, and combine both sources at API and assistant boundaries. Put all iCalendar normalization in pure functions so the API and tests share one contract.

**Tech Stack:** Netlify Functions, Netlify Blobs, vanilla HTML/CSS/JavaScript, Node.js built-in test runner.

## Global Constraints

- Scheduling help only; no practice, repertoire, or performance guidance.
- Imported and professional event details are private from students.
- `.ics` file import and combined `.ics` export are required.
- iCloud URL import is optional and restricted to HTTPS iCloud calendar URLs.
- Existing lesson, approval, OTP, reminder, and usage workflows must continue to work.

---

### Task 1: Calendar and iCalendar core

**Files:**
- Modify: `netlify/functions/_store.js`
- Modify: `netlify/functions/_ics.js`
- Create: `test/calendar-events.test.js`

**Interfaces:**
- Produces: `readCalendarEvents(store)`, `writeCalendarEvents(store, events)`, `parseCalendar(text, options)`, `buildScheduleCalendar({ lessons, events, calendarName })`, and `eventConflicts(events, candidate)`.

- [ ] **Step 1: Write failing tests** for Apple-style folded lines, UTC and TZID values, UID de-duplication, private defaults, text escaping, lesson recurrence, and combined export.
- [ ] **Step 2: Run `node --test test/calendar-events.test.js`** and confirm failures are caused by missing exports.
- [ ] **Step 3: Implement the pure parsing/export functions and event store helpers** with no external dependencies.
- [ ] **Step 4: Re-run `node --test test/calendar-events.test.js`** and confirm all cases pass.

### Task 2: Authenticated calendar API and public privacy

**Files:**
- Create: `netlify/functions/calendar-events.js`
- Modify: `netlify/functions/lessons.js`
- Create: `test/calendar-api.test.js`

**Interfaces:**
- Consumes: calendar helpers from Task 1 and `getAdminSession(event)`.
- Produces: admin `GET`, `POST`, and `DELETE` operations plus public sanitized `busyEvents`.

- [ ] **Step 1: Write failing handler tests** proving students receive only `Unavailable`, admins receive full details, invalid imports are rejected, and duplicate UIDs update instead of multiplying.
- [ ] **Step 2: Run `node --test test/calendar-api.test.js`** and confirm the route is missing.
- [ ] **Step 3: Implement JSON event CRUD, `.ics` text import, restricted iCloud URL import, and `.ics` export responses.**
- [ ] **Step 4: Re-run API and existing tests** with `node --test test/calendar-api.test.js test/*.test.js`.

### Task 3: Role-aware scheduling assistant

**Files:**
- Modify: `netlify/functions/assistant.js`
- Modify: `test/assistant-defaults.test.js`

**Interfaces:**
- Consumes: `isAdminUser(user)`, calendar-event storage, and combined availability context.
- Produces: `add_event`, `reschedule_event`, and `delete_event` actions for admins; private conflict messages for students.

- [ ] **Step 1: Add failing tests** for scheduling-only prompt policy, role-aware event fields, admin direct application, and private student conflict language.
- [ ] **Step 2: Run the focused assistant tests** and confirm the new assertions fail.
- [ ] **Step 3: Extend the model schema/context and action application** while leaving student lesson approval behavior intact.
- [ ] **Step 4: Re-run the focused and full backend test suite.**

### Task 4: Musician workspace and polished student experience

**Files:**
- Modify: `public/index.html`
- Modify: `public/admin/index.html`

**Interfaces:**
- Consumes: `/api/lessons`, `/api/assistant`, and `/api/calendar-events`.
- Produces: responsive public availability UI; admin assistant, combined schedule, event form, `.ics` upload, optional iCloud URL import, and export download.

- [ ] **Step 1: Add semantic UI hooks and frontend assertions to the existing Node tests** for the critical import/export and assistant controls.
- [ ] **Step 2: Confirm those assertions fail before editing HTML.**
- [ ] **Step 3: Implement the accessible editorial redesign and wire each control to its endpoint.**
- [ ] **Step 4: Run all Node tests and inspect both documents for duplicate IDs and JavaScript syntax errors.**

### Task 5: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces: setup/usage documentation and a repeatable `npm test` command.

- [ ] **Step 1: Document event privacy, file import, URL import, export, and musician/student assistant behavior.**
- [ ] **Step 2: Add `"scripts": { "test": "node --test test/*.test.js" }` to `package.json`.**
- [ ] **Step 3: Run `npm test` and `node --check` for every Netlify function.**
- [ ] **Step 4: Review `git diff --check` and the requirement checklist before handoff.**

