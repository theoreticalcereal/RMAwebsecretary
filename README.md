# Lesson Secretary

A lesson scheduling app with a public calendar view, a natural language
assistant powered by NVIDIA's NIM API, and a password protected admin
dashboard for the maintainer. Runs on Netlify with Blobs for storage, so
there's no separate database to manage.

## How it's laid out

- **Public page** (`/`): shows the calendar, read-only, plus the AI
  assistant box. This is the only way a visitor can add, cancel, or remove
  a lesson. There's no manual add form here anymore.
- **Admin dashboard** (`/admin`): password protected. Lets the maintainer
  add, edit, and delete lessons directly, and shows a live breakdown of
  today's assistant usage per visitor.
- **Assistant**: capped at 5 prompts per day, per visitor, tracked with a
  cookie. Once a visitor hits the cap, the app tells them it can't help
  further today and emails the maintainer once.

## What's included

- `netlify/functions/_store.js`: Blobs storage helpers (lessons,
  exceptions, per-visitor usage counters, and a usage listing function for
  the admin dashboard)
- `netlify/functions/_cookies.js`: reads or generates the `visitor_id`
  cookie used for the assistant's daily limit
- `netlify/functions/_notify.js`: emails the maintainer via Resend the
  first time a given visitor's daily cap is exceeded
- `netlify/functions/_admin_auth.js`: checks the `x-admin-password` header
  against `ADMIN_PASSWORD`
- `netlify/functions/lessons.js`: public, **read-only**. Returns the
  lesson list for the calendar view.
- `netlify/functions/admin-lessons.js`: admin-only CRUD for lessons
  (password protected)
- `netlify/functions/admin-stats.js`: admin-only usage stats for today
- `netlify/functions/assistant.js`: the NIM-powered assistant, the only
  way public visitors can change the schedule
- `public/index.html`: public calendar + assistant
- `public/admin/index.html`: password gated admin dashboard

## Setup

```bash
npm install
```

### Required env vars

```bash
NVIDIA_NIM_API_KEY=nvapi-...      # from https://build.nvidia.com
RESEND_API_KEY=re_...             # from https://resend.com (free tier)
MAINTAINER_EMAIL=you@example.com  # where the "limit reached" email goes
ADMIN_PASSWORD=choose-a-password  # protects /admin
```

Set these locally in a `.env` file (already gitignored, picked up
automatically by `netlify dev`), or in production with:

```bash
netlify env:set NVIDIA_NIM_API_KEY nvapi-...
netlify env:set RESEND_API_KEY re_...
netlify env:set MAINTAINER_EMAIL you@example.com
netlify env:set ADMIN_PASSWORD choose-a-password
```

Without `RESEND_API_KEY`/`MAINTAINER_EMAIL` set, the rate limit still
works, it just skips the email (logged as a warning). Without
`ADMIN_PASSWORD` set, every request to `/admin`'s API endpoints is
rejected, since there's nothing to check the password against.

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
- The frontend now sets an explicit 25 second timeout on the request and
  distinguishes three different failure points instead of lumping them
  into one message: a genuine network failure, a timeout, and a response
  that came back but couldn't be parsed as JSON. Whichever one happens,
  you'll see a message that says which, instead of a generic "network
  error" regardless of cause.

If you still see this after these changes, check your function's actual
duration in the Netlify dashboard's function logs. Netlify's free tier
caps synchronous function execution at 10 seconds; if the NIM call itself
is regularly taking longer than that, the fix is either a faster NIM model
or moving to Netlify's background functions for this endpoint.

## Try it

**Public page:**
1. Ask the assistant to add a lesson, it should show up on the calendar.
2. Ask something ambiguous, it should ask a clarifying question instead of
   guessing.
3. Send 5 requests, then a 6th, confirm you get the "can't help further
   today" message and (if Resend is configured) the maintainer gets one
   email.

**Admin dashboard:**
1. Go to `/admin`, log in with `ADMIN_PASSWORD`.
2. Add a lesson directly, confirm it shows up on both the admin and public
   calendars.
3. Check the usage table, it should reflect prompts used by any visitor
   who has used the assistant today.
4. Delete a lesson, confirm it disappears from both views.

## Deploying

```bash
netlify init      # first time only
netlify deploy --prod
```

## Known limitations and possible next steps

- The admin password is a single shared secret sent on every request. This
  is fine for personal/single-maintainer use, but isn't a substitute for
  proper authentication if more than one person needs admin access, or if
  the stakes go up.
- The per-visitor cookie is easy to work around (clearing cookies, private
  browsing, different browser). It's meant to catch accidental overuse,
  not to be a hard security boundary.
- Exceptions (one-off cancellations made via the assistant) are stored but
  not yet shown on either calendar view.