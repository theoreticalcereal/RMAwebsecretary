# Studio & Stage

A scheduling workspace for a music professional who teaches students and
attends concerts. It combines a student-facing lesson calendar, a role-aware
natural-language scheduling assistant powered by NVIDIA's NIM API, private
professional commitments, and Apple Calendar interoperability. It runs on
Netlify with Blobs for storage, so there's no separate database to manage.

The assistant is intentionally scheduling-only. It handles availability,
lesson requests, cancellations, rescheduling, concerts, rehearsals, and
private blocked time; it does not provide practice, repertoire, or performance
guidance.

## How it's laid out

- **Student page** (`/`): shows weekly studio availability and assistant chat. Visitors
  must sign in with email + verification code before using the assistant.
  Professional events are exposed here only as `Unavailable`; their titles,
  locations, notes, sources, and types stay private.
- **Musician workspace** (`/admin`): uses the same email OTP session with an
  admin allowlist. It includes the musician's scheduling assistant, combined
  lesson/professional calendar, event agenda, lesson management, pending
  approvals, working hours, and usage controls.
- **Assistant**: role-aware and capped at 5 prompts per day, per logged-in user, tracked
  with authenticated sessions. Once a user hits the cap, the app tells them it can't help
  further today and emails the maintainer once. Student lesson changes follow
  approval rules; musician concert, rehearsal, and blocked-time changes apply
  directly after conflict checks.

## Apple Calendar import and export

From `/admin`, the musician can:

1. Export a calendar from Apple Calendar as an `.ics` file and upload it in
   the **Apple Calendar** panel.
2. Optionally paste a public `webcal://` or `https://` iCloud Calendar URL and
   refresh it on demand. Only `icloud.com` hosts are accepted.
3. Download a combined `.ics` containing active lessons and professional
   commitments using **Export combined .ics**.

Timezone-aware recurring professional events are expanded into portable UTC
occurrences for the next two years during export. This avoids client-specific
`VTIMEZONE` behavior while preserving daylight-saving changes.

Imports are de-duplicated by iCalendar `UID`: later imports update matching
events rather than creating copies. Imported entries are always private from
students. Public iCloud links are bearer URLs—anyone who has one may be able to
read that calendar—so use a dedicated calendar and revoke the link in Apple
Calendar if it is exposed.

## What's included

- `netlify/functions/_store.js`: Blobs storage helpers (lessons,
  exceptions, per-user usage counters, and a usage listing function for
  the admin dashboard)
- `netlify/functions/_auth.js`: email OTP issuance/verification and session
  persistence helpers
- `netlify/functions/_notify.js`: emails the maintainer via Resend the
  first time a given user's daily cap is exceeded
- `netlify/functions/auth-request-code.js`: starts the email OTP flow
- `netlify/functions/auth-verify-code.js`: verifies the code and creates a
  login session
- `netlify/functions/auth-session.js`: reads/writes the shared session state
- `netlify/functions/lessons.js`: public, **read-only**. Returns the
  lesson list plus sanitized unavailable blocks for the student calendar.
- `netlify/functions/calendar-events.js`: admin-only professional event CRUD,
  Apple `.ics` import, restricted iCloud URL refresh, and combined `.ics`
  export.
- `netlify/functions/_ics.js`: iCalendar parsing, UID merging, conflict checks,
  lesson invitations, and combined calendar generation.
- `netlify/functions/admin-lessons.js`: admin-only CRUD for lessons using
  session auth
- `netlify/functions/admin-stats.js`: admin-only usage stats for today
- `netlify/functions/assistant.js`: the NIM-powered assistant, the only
  way public users can change the schedule or manage their own pending
  assistant requests. NIM chooses from the supported tool actions; the
  backend validates and executes only those actions.
- `public/index.html`: public calendar + assistant
- `public/admin/index.html`: session-gated admin dashboard

## Setup

```bash
npm install
```

### Required env vars

```bash
NVIDIA_NIM_API_KEY=nvapi-...      # from https://build.nvidia.com
RESEND_API_KEY=re_...             # from https://resend.com (free tier)
MAINTAINER_EMAIL=you@example.com  # where the "limit reached" email goes
RESEND_FROM_EMAIL=onboarding@resend.dev # optional: defaults to onboarding@resend.dev
ADMIN_EMAILS=admin@example.com   # comma-separated list of admin emails
AUTH_CODE_SECRET=pick-a-long-random-secret # optional: extra hardening for OTP hashing
STUDIO_TIMEZONE=America/Chicago  # optional: IANA timezone, defaults to America/Chicago
```

Set these locally in a `.env` file (already gitignored, picked up
automatically by `netlify dev`), or in production with:

```bash
netlify env:set NVIDIA_NIM_API_KEY nvapi-...
netlify env:set RESEND_API_KEY re_...
netlify env:set MAINTAINER_EMAIL you@example.com
netlify env:set RESEND_FROM_EMAIL onboarding@resend.dev
netlify env:set AUTH_CODE_SECRET pick-a-long-random-secret
netlify env:set ADMIN_EMAILS admin@example.com
netlify env:set STUDIO_TIMEZONE America/Chicago
```

`RESEND_API_KEY` is required for email verification flow and maintainer alerts.
`ADMIN_EMAILS` is required for admin access; requests from non-listed users
are rejected with `403`.

### Assistant reasoning allocation

The NIM assistant uses Netlify-oriented defaults baked into
`netlify/functions/assistant.js`:

- Full assistant parse timeout: 10 seconds
- Reason-only extraction timeout: 10 seconds
- Full assistant response cap: 768 tokens
- Reason-only response cap: 160 tokens
- Default model: `meta/llama-3.1-8b-instruct`

These values use the full 10 second synchronous Netlify function window.
Raising them further is only useful on a Netlify plan or function mode with a
longer execution window. For lower latency, use a faster model rather than
spending more prompt quota. Override the default with `NVIDIA_NIM_MODEL` if you
need a different NIM model.

```bash
netlify dev
```

## Troubleshooting "internal error"

If you're seeing a generic internal error on either the assistant or
lesson endpoints, the most common cause is Netlify Blobs not being
available in that deploy context. A few things to check:

0. **"...has not been configured with a 'uncachedEdgeURL' property"**:
   this specific error means the store was requested with strong
   consistency, which needs Blobs config that isn't always present in
   every context (some `netlify dev` setups, for example). This app uses
   the default eventual consistency for exactly this reason, so you
   shouldn't hit this anymore. If you do (say, after pulling an older
   copy of the code), check `netlify/functions/_store.js` and make sure
   `getStore()` is called without `consistency: "strong"`.
1. **Look at the actual error detail.** Every endpoint in this version
   returns `{ "error": "internal error", "detail": "..." }` instead of a
   bare message, and the frontend now displays that detail text instead of
   swallowing it. Open your browser's dev tools network tab and look at
   the failed request's response body, or check `netlify dev`'s terminal
   output / your site's function logs in the Netlify dashboard. The detail
   field will say what actually failed (missing env var, Blobs
   initialization failure, NIM API error, etc).
2. **Confirm you're running through Netlify, not a plain static server.**
   Functions and Blobs only work via `netlify dev` or an actual Netlify
   deploy. Opening `public/index.html` directly in a browser, or serving
   it with something like `npx serve`, will not have working `/api/*`
   routes at all.
3. **Confirm env vars are set and the site has been redeployed since.**
   Env vars set after a deploy don't apply retroactively, you need a new
   deploy (or `netlify dev` restart locally) to pick them up.
4. **Confirm the site is actually linked** (`netlify init` or
   `netlify link` run at least once), since Blobs needs a linked site
   context to know where to store data.

## "Network error, please try again" while the lesson still gets created

If the assistant successfully creates the lesson but the UI still shows a
network error, the request is completing on the backend but something is
going wrong on the way back to the browser, most likely a slow response
(the NIM call plus a few Blobs reads/writes in sequence) running long
enough to get cut off before the browser receives the full response.

Two things address this directly:

- `assistant.js` now parallelizes the independent reads (`readUsage` and
  `readLessons` run together instead of one after another) and no longer
  waits on the final usage-count write before responding, which cuts the
  number of sequential round-trips in the request.
- `assistant.js` gives the NIM call up to 9 seconds, which is close to the
  full synchronous Netlify free-tier window but still leaves room for the
  function to return a JSON timeout response.

If you still see this after these changes, check your function's actual
duration in the Netlify dashboard's function logs. Netlify's free tier
caps synchronous function execution at 10 seconds; if the NIM call itself
is regularly taking longer than that, the fix is either a faster NIM model
or moving to Netlify's background functions for this endpoint.

## Try it

**Public page:**
1. Ask the assistant to add a lesson; it should show up on the calendar.
2. Ask something ambiguous, it should ask a clarifying question instead of
   guessing.
3. Import a private event in the musician workspace, then confirm the public
   calendar displays only `Unavailable` at that time.
4. Send 5 requests, then a 6th, confirm you get the "can't help further
   today" message and (if Resend is configured) the maintainer gets one
   email.

**Admin dashboard:**
1. Go to `/admin`, sign in with an email listed in `ADMIN_EMAILS`.
2. Ask the assistant to add a concert and confirm it appears in the professional
   agenda and combined calendar.
3. Import an Apple Calendar `.ics`, then import it again and confirm matching
   UIDs update rather than duplicate.
4. Export the combined `.ics` and open it in Apple Calendar.
5. Add a lesson directly, confirm it shows up on both the admin and public
   calendars.
6. Check the usage table; it should reflect prompts used by any logged-in user
   who has used the assistant today.
7. Delete a lesson, confirm it disappears from both views.

## Deploying

```bash
netlify init      # first time only
netlify deploy --prod
```

## Known limitations and possible next steps

- iCloud URL refresh is on demand. The app does not store Apple credentials or
  run background sync jobs.
- Imported weekly recurrences support `BYDAY`, `INTERVAL`, and `UNTIL` for
  availability, conflict checks, and two-year export expansion. More complex
  monthly/yearly recurrence rules are stored, but only their initial occurrence
  appears in the current prototype's workspace and export.
- Apple `TZID` values and floating times are normalized to UTC using
  `STUDIO_TIMEZONE`; exports therefore remain portable without custom
  `VTIMEZONE` blocks. Set `STUDIO_TIMEZONE` to the musician's IANA timezone
  before importing calendars or creating events.

- Admin access is not protected by a shared password. It is tied to the same
  email-session identity model as the public page, with an allowlist in
  `ADMIN_EMAILS`.
- The identity/session model is cookie-backed with server-side lookup.
  It's stronger than the prior anonymous counter but not intended as a
  hardened identity platform. Keep session/cookie settings conservative for
  production, and rotate/expire env secrets as needed.
- Exceptions (one-off cancellations made via the assistant) are stored but
  not yet shown on either calendar view.
