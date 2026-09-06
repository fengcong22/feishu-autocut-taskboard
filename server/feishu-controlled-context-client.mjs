function fail(code, message, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw fail("CONTROLLED_CONTEXT_INVALID", `${name} is invalid`, 400);
  }
  return value.trim();
}

function validateBridgeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail("FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge URL is invalid", 503); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw fail("FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge must use loopback HTTP", 503);
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
}

/**
 * Refresh only the controlled document/name fields for an immutable subject
 * version.  The request body deliberately carries opaque identity only.
 */
export async function readCurrentControlledContext({ bridgeUrl, bridgeSecret, origin }) {
  const url = validateBridgeUrl(bridgeUrl);
  const secret = requireText(bridgeSecret, "bridgeSecret");
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) {
    throw fail("CONTROLLED_CONTEXT_INVALID", "origin is invalid", 400);
  }
  const body = {
    subjectKey: requireText(origin.subjectKey, "origin.subjectKey"),
    configVersion: origin.configVersion,
    baseToken: requireText(origin.baseToken, "origin.baseToken"),
    tableId: requireText(origin.tableId, "origin.tableId"),
    recordId: requireText(origin.recordId, "origin.recordId"),
  };
  if (!Number.isSafeInteger(body.configVersion) || body.configVersion < 1) {
    throw fail("CONTROLLED_CONTEXT_INVALID", "origin.configVersion is invalid", 400);
  }
  const endpoint = new URL("/api/feishu/workflow/controlled-context", url);
  let response;
  let payload = null;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-feishu-bridge-client": "taskboard",
        "x-feishu-bridge-secret": secret,
      },
      body: JSON.stringify(body),
    });
    try { payload = await response.json(); } catch {}
  } catch (error) {
    if (error?.code === "FEISHU_BRIDGE_UNAVAILABLE") throw error;
    throw fail("FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge controlled-context request failed", 503);
  }
  if (!response || response.status < 200 || response.status >= 300) {
    const code = typeof payload?.error?.code === "string"
      ? payload.error.code : "FEISHU_BRIDGE_CONTEXT_FAILED";
    throw fail(code, "Feishu Bridge could not read the controlled record context", response?.status >= 400 ? response.status : 502);
  }
  const context = payload?.controlledContext ?? payload;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw fail("CONTROLLED_CONTEXT_INVALID", "Feishu Bridge returned an invalid controlled context");
  }
  const links = context.documentLinks;
  if (!Array.isArray(links) || links.some((link) => typeof link !== "string" || link.length > 2048)) {
    throw fail("CONTROLLED_CONTEXT_INVALID", "Feishu Bridge returned invalid document links");
  }
  if (typeof context.namingDisplayValue !== "string" || typeof context.namingValueUnique !== "boolean") {
    throw fail("CONTROLLED_CONTEXT_INVALID", "Feishu Bridge returned invalid naming context");
  }
  return {
    documentLinks: links.map((link) => link.trim()),
    namingDisplayValue: context.namingDisplayValue,
    namingValueUnique: context.namingValueUnique,
  };
}
