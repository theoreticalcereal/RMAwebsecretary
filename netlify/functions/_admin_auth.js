// Very simple password-based auth for the admin dashboard. Not meant to be
// a robust security system, just enough to keep the admin routes from
// being wide open to anyone with the URL, per the "simple password (env
// var), good enough for personal use" approach.
//
// The admin frontend sends the password in an "x-admin-password" header on
// every request. We compare it against ADMIN_PASSWORD from the environment.

function checkAdminAuth(event) {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) {
    return { ok: false, reason: "ADMIN_PASSWORD is not set in environment" };
  }

  const provided = event.headers?.["x-admin-password"] || event.headers?.["X-Admin-Password"];
  if (!provided || provided !== configured) {
    return { ok: false, reason: "incorrect or missing password" };
  }

  return { ok: true };
}

module.exports = { checkAdminAuth };