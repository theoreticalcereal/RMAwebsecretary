const { requestLoginCode } = require("./_auth");
const { jsonResponse } = require("./_store");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "method not allowed" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const result = await requestLoginCode(event, body.email);
  if (!result.ok) {
    return jsonResponse(400, { error: "request failed", detail: result.reason });
  }

  return jsonResponse(200, { ok: true });
};
