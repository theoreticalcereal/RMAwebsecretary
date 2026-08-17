# Music Professional Scheduler Design

## Goal

Polish Lesson Secretary into a scheduling workspace for a working musician who teaches students and attends concerts, while keeping the assistant focused exclusively on scheduling.

## Users and privacy

- The musician is any authenticated account on the existing admin allowlist.
- Students are authenticated non-admin users.
- The musician sees titles, locations, sources, and event types for all schedule entries.
- Students see lesson details, but concerts, rehearsals, imported appointments, and private blocks are shown only as `Unavailable`.

## Schedule model

Existing lessons remain in the lesson store and keep their approval and reminder behavior. A new `calendar_events` store holds one-off professional commitments with these fields: `id`, `uid`, `title`, `eventType`, `start`, `end`, `location`, `notes`, `source`, and `private`.

Supported event types are `concert`, `rehearsal`, and `unavailable`. Imported entries default to `unavailable` when their type cannot be inferred. All imported events are private.

## Apple Calendar interoperability

The admin page accepts an Apple Calendar `.ics` file. The browser reads the file as text and sends it to an authenticated endpoint; the server parses `VEVENT` entries, unfolds continuation lines, accepts local, UTC, date-only, and `TZID` date values, de-duplicates by `UID`, and stores normalized events. Invalid files return a useful validation message and do not overwrite existing schedule data.

The admin can download the combined lesson and professional schedule as a standards-compatible `.ics` file. Exported entries include stable UIDs, escaped text, dates, times, locations, and weekly recurrence for recurring lessons.

An optional public iCloud `.ics` URL can be pasted into the import panel. The server fetches it only after validating that it is an HTTPS `icloud.com` or `webcal://icloud.com` URL, then processes it through the same importer. It is an on-demand refresh, not a background sync.

## Assistant behavior

The assistant receives both lessons and professional schedule context. It never offers repertoire, practice, or performance coaching.

For students, existing add, reschedule, cancel, query, and pending-request actions remain. Professional commitments are described only as unavailable blocks, and conflicts are checked against both lessons and events.

For the musician, the assistant can query the complete schedule and directly create, reschedule, or remove concerts, rehearsals, and unavailable blocks. Event-changing actions require a date plus start and end times. Ambiguous requests produce one concise clarifying question.

## Interface

The public page becomes a calmer studio schedule with a clear assistant-first layout, sample scheduling prompts, a weekly availability view, and an explicit privacy note.

The admin page becomes the musician's `Studio & Stage` workspace. The most-used tools appear first: scheduling assistant, at-a-glance counts, combined calendar, event creation, and Apple Calendar import/export. Existing approval, usage, identity, working-hours, and off-time controls remain available below as operations settings.

Both pages use a warm editorial palette, stronger hierarchy, generous spacing, accessible focus states, semantic labels, responsive layouts, and reduced-motion-friendly transitions.

## Error handling and testing

- Parsing and exporting live in pure functions covered by Node tests.
- API tests use in-memory stores and authenticated-session stubs.
- Import reports imported, updated, and skipped counts.
- Conflicts return the colliding time range without revealing private event titles to students.
- Existing tests remain green.

