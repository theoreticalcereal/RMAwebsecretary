# Calendar Reminders and Off-Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email-delivered calendar invites, user reminder preferences, visual distinction for recurring versus one-off lessons, and maintainer unavailable-window scaffolding.

**Architecture:** Store user notification preferences and maintainer off-time windows in Netlify Blobs through `_store.js`. Generate standards-compatible ICS text in a focused helper, send it through the existing Resend email helper, and call it from the assistant/admin mutation paths. Keep calendar rendering serverless and simple by exposing enough lesson metadata through existing APIs.

**Tech Stack:** Netlify Functions, Netlify Blobs, plain HTML/CSS/JS, Node `node:test`, Resend email API.

## Global Constraints

- Do not add SMS support.
- Reuse Resend for delivery.
- Do not add a database or front-end framework.
- Preserve existing assistant approval behavior and pending-review flow.
- Keep AI renegotiation as pending/reviewable requests, not direct silent lesson movement.

---

### Task 1: Reminder Preference Storage and API

**Files:**
- Modify: `netlify/functions/_store.js`
- Create: `netlify/functions/reminder-settings.js`
- Test: `test/reminder-settings.test.js`

**Interfaces:**
- Produces: `readReminderSettings(store, userId) -> Promise<{delivery:string, offsetsMinutes:number[]}>`
- Produces: `writeReminderSettings(store, userId, settings) -> Promise<object>`
- Produces: `normalizeReminderSettings(settings) -> {delivery:string, offsetsMinutes:number[]}`

- [ ] Write failing tests for default preferences, saving valid preferences, and rejecting unauthenticated access.
- [ ] Run `node --test test/reminder-settings.test.js` and confirm failure.
- [ ] Implement store helpers and `/api/reminder-settings`.
- [ ] Run `node --test test/reminder-settings.test.js` and confirm pass.

### Task 2: ICS Generation and Email Delivery

**Files:**
- Create: `netlify/functions/_ics.js`
- Modify: `netlify/functions/_notify.js`
- Test: `test/ics.test.js`

**Interfaces:**
- Produces: `buildLessonInvite({ lesson, method, sequence, organizerEmail, attendeeEmail, offsetsMinutes }) -> { filename:string, content:string, contentType:string }`
- Produces: `sendLessonInviteEmail({ to, lesson, invite }) -> Promise<{sent:boolean, reason?:string}>`

- [ ] Write failing tests proving recurring lessons include `RRULE:FREQ=WEEKLY`, one-off lessons omit RRULE, alarms match offsets, and cancel invites use `METHOD:CANCEL`.
- [ ] Run `node --test test/ics.test.js` and confirm failure.
- [ ] Implement ICS escaping, UTC date formatting, weekly day mapping, VALARM blocks, and Resend attachment payload.
- [ ] Run `node --test test/ics.test.js` and confirm pass.

### Task 3: Send Invites From Lesson Mutations

**Files:**
- Modify: `netlify/functions/assistant.js`
- Modify: `netlify/functions/admin-lessons.js`
- Test: `test/assistant-defaults.test.js`

**Interfaces:**
- Consumes: `readReminderSettings`, `buildLessonInvite`, `sendLessonInviteEmail`.
- Produces: mutation responses with optional `invite: { sent:boolean, reason?:string }`.

- [ ] Write failing assistant tests for an auto-approved add sending an invite when delivery includes `calendar`, and not sending when delivery is `none`.
- [ ] Run the targeted tests and confirm failure.
- [ ] Call reminder helpers after add/reschedule/cancel/delete paths that successfully apply.
- [ ] Run `node --test test/assistant-defaults.test.js` and confirm pass.

### Task 4: User Preference UI and Calendar Colors

**Files:**
- Modify: `public/index.html`
- Modify: `netlify/functions/lessons.js` if needed

**Interfaces:**
- Consumes: `/api/reminder-settings`.
- Produces: user-facing controls for delivery mode and reminder timing.

- [ ] Add signed-in preference controls near the assistant usage area.
- [ ] Fetch current settings on sign-in and save changes through `/api/reminder-settings`.
- [ ] Add `.lesson-card.recurring` and `.lesson-card.one-off` styles.
- [ ] Render recurring weekly lessons and one-off lessons with different classes.

### Task 5: Maintainer Off-Time Storage and Admin UI

**Files:**
- Modify: `netlify/functions/_store.js`
- Modify: `netlify/functions/admin-lessons.js`
- Modify: `public/admin/index.html`
- Test: `test/admin-offtime.test.js`

**Interfaces:**
- Produces: `readOffTimeWindows(store) -> Promise<object[]>`
- Produces: `writeOffTimeWindows(store, windows) -> Promise<object[]>`

- [ ] Write failing tests for adding an off-time window and listing affected active lessons.
- [ ] Implement store helpers and admin operations `save_offtime_window` and `delete_offtime_window`.
- [ ] Add admin form/table for weekly unavailable windows.
- [ ] Return affected lessons for maintainer review.

### Task 6: AI Renegotiation Scaffolding

**Files:**
- Modify: `netlify/functions/assistant.js`
- Modify: `netlify/functions/admin-lessons.js`
- Test: `test/admin-offtime.test.js`

**Interfaces:**
- Consumes: pending change shape already used by assistant approval.
- Produces: pending `reschedule` requests tagged with `source: "off-time-renegotiation"`.

- [ ] Write failing tests that off-time proposal creates pending reschedule requests instead of directly moving lessons.
- [ ] Implement deterministic pending request generation for affected lessons with notes requiring user/maintainer confirmation.
- [ ] Keep any AI-suggested exact times reviewable through existing pending approval flow.
