// Small helper for reading/writing a "visitor_id" cookie, used to track
// the per-user daily assistant prompt limit. No external dependency needed,
// this is just plain header parsing/building.

const crypto = require("crypto");

const COOKIE_NAME = "visitor_id";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// Parses the incoming Cookie header and returns the visitor_id if present.
function getVisitorId(event) {
  const cookieHeader = event.headers?.cookie || event.headers?.Cookie || "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return match ? match.split("=")[1] : null;
}

// Returns { visitorId, setCookieHeader } - setCookieHeader is null if the
// visitor already had a cookie (nothing new to set).
function resolveVisitor(event) {
  const existing = getVisitorId(event);
  if (existing) return { visitorId: existing, setCookieHeader: null };

  const visitorId = crypto.randomUUID();
  const setCookieHeader = `${COOKIE_NAME}=${visitorId}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
  return { visitorId, setCookieHeader };
}

module.exports = { getVisitorId, resolveVisitor, COOKIE_NAME };