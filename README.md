# Lesson Secretary

A simple lesson scheduling app with a calendar view, manual add/edit/delete,
and a natural language assistant powered by NVIDIA's NIM API. Runs on
Netlify with Blobs for storage, so there's no separate database to manage.

The assistant is capped at 5 prompts per day, per visitor. Each browser
gets a cookie the first time it uses the assistant, and that cookie is
what the daily limit is tracked against. This is tracked server-side, so
it can't be reset by reloading the page or clearing localStorage (clearing
cookies or switching browsers would get a fresh bucket though). If someone
hits their cap, the app tells them it can't help further that day and
sends a one-time email to the maintainer so a human can follow up if needed.

## What's included

- `netlify/functions/_store.js`: Blobs storage helpers, including
  `readUsage`/`writeUsage` for the per-visitor daily prompt counter
  (`usage:YYYY-MM-DD:<visitorId>`)
- `netlify/functions/_cookies.js`: reads the incoming `visitor_id` cookie,
  or generates a new one if it's missing
- `netlify/functions/_notify.js`: emails the maintainer via Resend the
  first time a given visitor's daily cap is exceeded
- `netlify/functions/lessons.js`: manual CRUD for lessons, add/edit/delete
  with conflict checking
- `netlify/functions/assistant.js`: NIM-powered assistant, gated by
  `DAILY_PROMPT_LIMIT = 5` per visitor. Also exposes `GET /api/assistant`
  to check today's usage for the current visitor without spending a prompt
- `public/index.html`: full calendar UI, manual form, and assistant box,
  showing "N of 5 requests left today" and disabling the input once that
  visitor's limit is hit

## How the limit works

Each browser that hits the assistant gets a `visitor_id` cookie (a random
UUID, set with a one year expiry) if it doesn't already have one. Usage is
tracked server-side in Blobs, keyed by both the date and that visitor ID,
so it can't be reset by reloading or clearing localStorage.

Manual calendar actions (add and delete via the form) aren't limited at
all, since they never call the AI.

Once a visitor's 6th request of the day comes in, `assistant.js` skips the
NIM call entirely, returns a message saying it can't help further today,
and (only the first time this happens for that visitor that day) emails
the maintainer. Each visitor's limit resets automatically at midnight UTC,
since a new date means a new counter key.

## Setup

```bash
npm install
```

### Required env vars

```bash
NVIDIA_NIM_API_KEY=nvapi-...      # from https://build.nvidia.com
RESEND_API_KEY=re_...             # from https://resend.com (free tier)
MAINTAINER_EMAIL=you@example.com  # where the "limit reached" email goes
```

Set these locally in a `.env` file (already gitignored, picked up
automatically by `netlify dev`), or in production with:

```bash
netlify env:set NVIDIA_NIM_API_KEY nvapi-...
netlify env:set RESEND_API_KEY re_...
netlify env:set MAINTAINER_EMAIL you@example.com
```

Without `RESEND_API_KEY` and `MAINTAINER_EMAIL` set, the rate limit still
works correctly. It just skips sending the email (logged as a warning)
instead of failing.

The email sends from `onboarding@resend.dev`, which works without domain
verification on Resend's free tier. You can swap the `from` address in
`netlify/functions/_notify.js` if you verify your own domain later.

```bash
netlify dev
```

## Try it

1. Send 5 assistant requests from the same browser. The counter should
   count down each time.
2. Send a 6th. You should get a message saying it can't help further
   today, and (if Resend is configured) you should get one email.
3. Send a 7th. It should get blocked the same way, but no second email.
4. Open the app in a different browser (or an incognito window). It
   should have its own fresh count of 5, since it gets its own cookie.
5. Confirm manual add and delete still work with no restriction.
6. Wait until after midnight UTC (or manually delete that visitor's
   `usage:YYYY-MM-DD:<visitorId>` blob) and confirm the counter resets.

## Deploying

```bash
netlify init      # first time only
netlify deploy --prod
```

## Known limitations and possible next steps

- Single user data model, no authentication. Anyone with the URL can read
  and write the schedule. The per-visitor cookie limits assistant usage
  per browser, but doesn't restrict who can use the app.
- The cookie is easy to clear or work around by a determined user (private
  browsing, clearing cookies, switching browsers). It's meant to catch
  accidental overuse, not to be a hard security boundary.
- Exceptions (one-off cancellations) are stored but not yet shown on the
  calendar.