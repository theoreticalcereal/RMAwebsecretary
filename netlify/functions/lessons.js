
const { getLessonStore, readLessons, readExceptions, readCalendarEvents, jsonResponse } = require("./_store");
const { currentStudioWeek, expandCalendarEvents, expandLessonOccurrences } = require("./_schedule");

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "method not allowed - lessons can only be read here; use the assistant or admin dashboard to make changes" });
  }

  try {
    const store = getLessonStore(event);
    const [lessons, exceptions, calendarEvents] = await Promise.all([
      readLessons(store),
      readExceptions(store),
      readCalendarEvents(store),
    ]);
    const busyEvents = calendarEvents.map((calendarEvent) => ({
      id: calendarEvent.id,
      title: "Unavailable",
      eventType: "unavailable",
      start: calendarEvent.start,
      end: calendarEvent.end,
      allDay: Boolean(calendarEvent.allDay),
      recurrence: calendarEvent.recurrence || null,
    }));
    const week = currentStudioWeek();
    const lessonOccurrences = expandLessonOccurrences(lessons, exceptions, week);
    const busyOccurrences = expandCalendarEvents(calendarEvents, week).flatMap((calendarEvent) => {
      const segments = calendarEvent.displaySegments?.length
        ? calendarEvent.displaySegments
        : [{ date: calendarEvent.date, startTime: calendarEvent.startTime, endTime: calendarEvent.endTime }];
      return segments.map((segment) => ({
        id: calendarEvent.id,
        occurrenceId: `${calendarEvent.occurrenceId}:${segment.date}`,
        title: "Unavailable",
        eventType: "unavailable",
        start: calendarEvent.start,
        end: calendarEvent.end,
        date: segment.date,
        startTime: segment.startTime,
        endTime: segment.endTime,
        allDay: Boolean(calendarEvent.allDay),
        recurrence: calendarEvent.recurrence || null,
      }));
    });
    return jsonResponse(200, { lessons, lessonOccurrences, exceptions, busyEvents, busyOccurrences, week, dayNames: DAY_NAMES });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
  }
};
