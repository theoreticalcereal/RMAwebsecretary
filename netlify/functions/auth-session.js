const { jsonResponse } = require("./_store");
const { clearSessionCookie, getSession, isAdminUser, getMaintainerEmail } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const user = await getSession(event);
    if (!user) return jsonResponse(401, { authenticated: false });
    return jsonResponse(200, {
      authenticated: true,
      user: { email: user.email, id: user.id },
      admin: isAdminUser(user),
      maintainerEmail: getMaintainerEmail(),
    });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, { error: "invalid JSON body" });
    }
    const { action } = body;
    if (action === "logout") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie() },
        body: JSON.stringify({ ok: true }),
      };
    }

    return jsonResponse(400, { error: "unsupported action" });
  }

  return jsonResponse(405, { error: "method not allowed" });
};
