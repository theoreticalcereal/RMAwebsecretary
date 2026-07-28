// Sends a plain-text notification email to the maintainer via Resend's REST
// API (https://resend.com). Uses raw fetch rather than the resend npm
// package to avoid an extra dependency for a single API call.
//
// Requires two env vars:
//   RESEND_API_KEY    - from resend.com (free tier: 3,000 emails/mo, 100/day)
//   MAINTAINER_EMAIL  - where the notification should be sent
//
// If either is missing, this silently no-ops (logged) rather than throwing 
// a missing notification shouldn't break the assistant's rate-limit behavior.

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
        // resend.dev sending address works without domain verification,
        // for free-tier/testing use. Swap for a verified domain address
        // once you've set one up in Resend.
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

module.exports = { notifyMaintainer };
