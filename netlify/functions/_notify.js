
const RESEND_URL = "https://api.resend.com/emails";

async function notifyMaintainer({ promptCount, date }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.MAINTAINER_EMAIL;

  if (!apiKey || !to) {
    console.warn("notifyMaintainer skipped: RESEND_API_KEY or MAINTAINER_EMAIL not set");
    return { sent: false, reason: "missing config" };
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: "Lesson Secretary <onboarding@resend.dev>",
        to: [to],
        subject: "Lesson Secretary: daily assistant limit reached",
        text: `The natural-language assistant hit its daily limit of ${promptCount} prompts on ${date}.\n\nFurther requests today are being told to contact you directly instead of calling the NIM API. No action needed unless this is unexpected or you want to raise the limit.`,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`Resend API error ${res.status}: ${detail}`);
      return { sent: false, reason: `resend error ${res.status}` };
    }

    return { sent: true };
  } catch (err) {
    console.error("notifyMaintainer failed:", err);
    return { sent: false, reason: String(err) };
  }
}

async function sendLoginCodeEmail({ email, code }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

  if (!apiKey) {
    console.warn("sendLoginCodeEmail skipped: RESEND_API_KEY not set");
    return { sent: false, reason: "missing RESEND_API_KEY" };
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: `Lesson Secretary <${from}>`,
        to: [email],
        subject: "Your Lesson Secretary verification code",
        text: `Your verification code is ${code}. It expires in 10 minutes.`,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`Resend OTP email error ${res.status}: ${detail}`);
      return { sent: false, reason: `resend error ${res.status}` };
    }

    return { sent: true };
  } catch (err) {
    console.error("sendLoginCodeEmail failed:", err);
    return { sent: false, reason: String(err) };
  }
}

async function sendLessonInviteEmail({ to, lesson, invite }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

  if (!apiKey || !to) {
    console.warn("sendLessonInviteEmail skipped: RESEND_API_KEY or recipient not set");
    return { sent: false, reason: "missing config" };
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: `Lesson Secretary <${from}>`,
        to: [to],
        subject: `Lesson calendar invite: ${lesson.subject || "Lesson"} with ${lesson.student || "student"}`,
        text:
          `Attached is a calendar invite for ${lesson.subject || "your lesson"}`
          + ` with ${lesson.student || "your student"}.`,
        attachments: [
          {
            filename: invite.filename,
            content: Buffer.from(invite.content, "utf8").toString("base64"),
            content_type: invite.contentType,
          },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`Resend lesson invite error ${res.status}: ${detail}`);
      return { sent: false, reason: `resend error ${res.status}` };
    }

    return { sent: true };
  } catch (err) {
    console.error("sendLessonInviteEmail failed:", err);
    return { sent: false, reason: String(err) };
  }
}

async function sendOffTimeProposalEmail({ to, lesson, window, proposedAction, actorEmail }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

  if (!apiKey || !to) {
    console.warn("sendOffTimeProposalEmail skipped: RESEND_API_KEY or recipient not set");
    return { sent: false, reason: "missing config" };
  }

  const windowLabel =
    window.kind === "dated"
      ? `${window.specific_date} ${window.start_time}-${window.end_time}`
      : `${window.start_time}-${window.end_time}`;
  const lessonLabel = `${lesson.subject || "Lesson"} with ${lesson.student || "student"}`;

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: `Lesson Secretary <${from}>`,
        to: [to],
        subject: `Proposed lesson reschedule: ${lessonLabel}`,
        text:
          `${actorEmail || "The maintainer"} marked ${windowLabel} as unavailable.`
          + `\n\nThis affects ${lessonLabel}, currently scheduled ${lesson.start_time}-${lesson.end_time}.`
          + `\n\nProposed new time: ${proposedAction.start_time}-${proposedAction.end_time}.`
          + `\n\nPlease sign in to Lesson Secretary to review or ask for a different time.`,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`Resend off-time proposal error ${res.status}: ${detail}`);
      return { sent: false, reason: `resend error ${res.status}` };
    }

    return { sent: true };
  } catch (err) {
    console.error("sendOffTimeProposalEmail failed:", err);
    return { sent: false, reason: String(err) };
  }
}

module.exports = { notifyMaintainer, sendLoginCodeEmail, sendLessonInviteEmail, sendOffTimeProposalEmail };
