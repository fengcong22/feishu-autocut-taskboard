import { ApiError } from "./database.mjs";

export function createFeishuWorkflowApi({ store }) {
  return {
    async handle({ method, pathname, body }) {
      if (pathname === "/api/local/feishu/workflow/catalog") {
        if (method === "GET") return { status: 200, body: { catalog: await store.listCatalog() } };
        if (method === "POST") return { status: 201, body: { catalog: [await store.upsertBasePreview(body)] } };
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }
      const match = pathname.match(/^\/api\/local\/feishu\/workflow\/subjects\/([^/]+)(?:\/(enable|disable))?$/);
      if (!match) return null;
      let subjectKey;
      try { subjectKey = decodeURIComponent(match[1]); } catch { throw new ApiError(400, "INVALID_PATH", "Subject key contains invalid encoding"); }
      if (match[2]) {
        if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        if (!Number.isInteger(body?.expectedVersion)) throw new ApiError(400, "INVALID_FIELD", "expectedVersion must be an integer");
        const subject = match[2] === "enable"
          ? await store.enableSubject(subjectKey, body.expectedVersion)
          : await store.disableSubject(subjectKey, body.expectedVersion);
        return { status: 200, body: { subject } };
      }
      if (method !== "PATCH") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      return { status: 200, body: { subject: await store.saveSubjectDraft(subjectKey, body) } };
    },
  };
}

