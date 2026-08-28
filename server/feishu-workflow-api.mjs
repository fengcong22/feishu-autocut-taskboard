import { ApiError } from "./database.mjs";

const BRIDGE_MACHINE_LOCAL_DIAGNOSTIC_CODES = new Set([
  "ARTIFACT_SOURCE_PATH_UNBOUND",
  "UPLOAD_TARGET_PATH_UNBOUND",
]);

function mergeDiagnostics(...groups) {
  const diagnostics = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const key = `${entry.code ?? ""}\u0000${entry.path ?? ""}\u0000${entry.alias ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(entry);
    }
  }
  return diagnostics;
}

export function createFeishuWorkflowApi({ store, previewBase = null, inspectShareImport = null }) {
  return {
    async handle({ method, pathname, body }) {
      if (pathname === "/api/local/feishu/workflow/share/export") {
        if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        return { status: 200, body: { configuration: await store.exportShareable() } };
      }
      if (pathname === "/api/local/feishu/workflow/share/import") {
        if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new ApiError(400, "INVALID_BODY", "Share import body must be an object");
        }
        const unknown = Object.keys(body).find((key) => !new Set(["configuration", "dryRun"]).has(key));
        if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `Unknown share import field '${unknown}'`);
        if (!Object.hasOwn(body, "configuration")) {
          throw new ApiError(400, "INVALID_FIELD", "configuration is required");
        }
        if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
          throw new ApiError(400, "INVALID_FIELD", "dryRun must be boolean");
        }
        const localPreview = await store.importShareable(body.configuration, { dryRun: true });
        const bridgePreview = typeof inspectShareImport === "function"
          ? await inspectShareImport(localPreview.configuration)
          : null;
        const bridgeDiagnostics = Array.isArray(bridgePreview?.diagnostics)
          ? bridgePreview.diagnostics.filter((entry) => (
            !BRIDGE_MACHINE_LOCAL_DIAGNOSTIC_CODES.has(entry?.code)
          ))
          : [];
        if (body.dryRun === true) {
          const diagnostics = mergeDiagnostics(bridgeDiagnostics, localPreview.diagnostics);
          const diagnosticsOk = diagnostics.every((entry) => entry.severity !== "error");
          return {
            status: 200,
            body: { ...localPreview, diagnostics, diagnosticsOk, dryRun: true },
          };
        }
        const result = await store.importShareable(localPreview.configuration, { dryRun: false });
        const diagnostics = mergeDiagnostics(bridgeDiagnostics, result.diagnostics);
        const diagnosticsOk = diagnostics.every((entry) => entry.severity !== "error");
        return {
          status: 200,
          body: { ...result, diagnostics, diagnosticsOk, dryRun: false },
        };
      }
      if (pathname === "/api/local/feishu/workflow/subjects") {
        if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        return { status: 200, body: { subjects: (await store.listCatalog()).flatMap((base) => base.subjects) } };
      }
      if (pathname === "/api/local/feishu/workflow/package-aliases") {
        if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        return { status: 200, body: { aliases: await store.packageAliases() } };
      }
      if (pathname === "/api/local/feishu/workflow/catalog") {
        if (method === "GET") return { status: 200, body: { catalog: await store.listCatalog() } };
        if (method === "POST") {
          let preview = body;
          if (typeof body?.url === "string") {
            if (typeof previewBase !== "function") {
              throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge preview is unavailable");
            }
            preview = await previewBase(body.url);
          }
          return { status: 201, body: { catalog: [await store.upsertBasePreview(preview)] } };
        }
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }
      const baseMatch = pathname.match(/^\/api\/local\/feishu\/workflow\/bases\/([^/]+)$/);
      if (baseMatch) {
        if (method !== "DELETE") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        let baseToken;
        try { baseToken = decodeURIComponent(baseMatch[1]); } catch { throw new ApiError(400, "INVALID_PATH", "Base token contains invalid encoding"); }
        return { status: 200, body: { catalog: await store.removeBase(baseToken) } };
      }
      const match = pathname.match(/^\/api\/local\/feishu\/workflow\/subjects\/([^/]+)(?:\/(enable|disable|display))?$/);
      if (!match) return null;
      let subjectKey;
      try { subjectKey = decodeURIComponent(match[1]); } catch { throw new ApiError(400, "INVALID_PATH", "Subject key contains invalid encoding"); }
      if (match[2]) {
        if (match[2] === "display") {
          if (method !== "PATCH") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          if (typeof body?.displayEnabled !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "displayEnabled must be boolean");
          }
          const subject = await store.setSubjectDisplayEnabled(subjectKey, body.displayEnabled);
          return { status: 200, body: { subject } };
        }
        if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        if (!Number.isInteger(body?.expectedVersion)) throw new ApiError(400, "INVALID_FIELD", "expectedVersion must be an integer");
        const subject = match[2] === "enable"
          ? await store.enableSubject(subjectKey, body.expectedVersion)
          : await store.disableSubject(subjectKey, body.expectedVersion);
        return { status: 200, body: { subject } };
      }
      if (method === "GET") {
        return { status: 200, body: { subject: await store.getSubject(subjectKey) } };
      }
      if (method === "DELETE") {
        return { status: 200, body: { catalog: await store.removeSubject(subjectKey) } };
      }
      if (method !== "PATCH") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      return { status: 200, body: { subject: await store.saveSubjectDraft(subjectKey, body) } };
    },
  };
}
