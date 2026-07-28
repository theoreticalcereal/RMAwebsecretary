const { verifyLoginCode } = require("./_auth");
const { jsonResponse } = require("./_store");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "method not allowed" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const result = await verifyLoginCode(event, body.email, body.code);
  if (!result.ok) {
    return jsonResponse(400, { error: "verification failed", detail: result.reason });
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": result.setCookie,
    },
    body: JSON.stringify({
      ok: true,
      user: result.user,
    }),
  };
};
