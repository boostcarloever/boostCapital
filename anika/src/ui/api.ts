/** Thin typed client for the local Anika server. */
import type {
  Decision,
  DraftVersion,
  Example,
  Id,
  PersonaRevision,
  Project,
  Proposal,
  Run,
} from "../core/types";

export interface AppState {
  workspace: { id: Id; root: string; createdAt: string };
  personas: { head: PersonaRevision; revisionCount: number }[];
  quarantined: { personaId: Id; revisionId: Id; reason: string }[];
  projects: Project[];
  examples: Example[];
  proposals: Proposal[];
  decisions: Decision[];
  processor: {
    available: boolean;
    provider: string;
    model: string;
    sends: string[];
    neverSends: string[];
    fallback: string;
  };
  usage: { requests: number; inputTokens: number; outputTokens: number; someUnknown: boolean };
}

export type DraftMeta = Omit<DraftVersion, "editorJson"> & { words: number };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string | null,
    readonly detail: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("STORAGE_UNAVAILABLE", "Anika's local service is not responding.", "Restart Anika. Your last acknowledged save is on disk.", null);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.code ?? "UNKNOWN", data?.message ?? `Request failed (${res.status}).`, data?.recovery ?? null, data?.detail ?? null);
  return data as T;
}

export const opId = () => `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const api = {
  state: () => call<AppState>("GET", "/api/state"),

  createPersona: (b: { name: string; modeName: string; modeDescription: string }) => call<PersonaRevision>("POST", "/api/personas", { ...b, opId: opId() }),
  revisions: (pid: Id) => call<PersonaRevision[]>("GET", `/api/personas/${pid}/revisions`),
  addMode: (pid: Id, b: { expectedRevision: Id; name: string; description: string }) => call<PersonaRevision>("POST", `/api/personas/${pid}/modes`, b),
  setPolicy: (pid: Id, b: { expectedRevision: Id; learningPolicy: string }) => call<PersonaRevision>("POST", `/api/personas/${pid}/policy`, b),
  addRule: (pid: Id, b: unknown) => call<PersonaRevision>("POST", `/api/personas/${pid}/rules`, b),
  updateRule: (pid: Id, rid: Id, b: unknown) => call<PersonaRevision>("POST", `/api/personas/${pid}/rules/${rid}`, b),
  retireRule: (pid: Id, rid: Id, b: { expectedRevision: Id }) => call<PersonaRevision>("POST", `/api/personas/${pid}/rules/${rid}/retire`, b),
  restore: (pid: Id, b: { expectedRevision: Id; targetRevision: Id }) => call<PersonaRevision>("POST", `/api/personas/${pid}/restore`, b),
  proposeProfile: (pid: Id, modeId: Id) => call<{ proposal: Proposal; discardedWithoutEvidence: number; provisional: boolean }>("POST", `/api/personas/${pid}/profile`, { modeId }),
  exportUrl: (pid: Id) => `/api/personas/${pid}/export`,
  importPlan: (bundle: unknown) => call<Record<string, unknown>>("POST", "/api/import/plan", bundle),
  importApply: (bundle: unknown) => call<Record<string, unknown>>("POST", "/api/import/apply", bundle),

  approve: (id: Id, b: { hash: string; expectedRevision: Id }) => call<unknown>("POST", `/api/proposals/${id}/approve`, { ...b, opId: opId() }),
  approvePartial: (id: Id, b: { hash: string; expectedRevision: Id; keepRuleIds: Id[]; edits?: Record<Id, string> }) => call<unknown>("POST", `/api/proposals/${id}/approve-partial`, b),
  reject: (id: Id) => call<Proposal>("POST", `/api/proposals/${id}/reject`),

  feedback: (b: { projectId: Id; draftVersionId: Id; blockId: Id; before: string; after?: string | null; feedback: string; scope: "task" | "mode" | "core" }) =>
    call<{ decision: Decision; proposal: Proposal | null; committed: PersonaRevision | null; note: string }>("POST", "/api/feedback", { ...b, opId: opId() }),
  findingFeedback: (b: { runId: Id; findingId: Id; action: "dismiss_for_draft" | "not_an_issue"; choice?: string; note?: string; newStatement?: string }) =>
    call<{ run: Run; proposal: Proposal | null }>("POST", "/api/findings/feedback", b),

  createProject: (b: { personaId: Id; modeId: Id; title: string; brief?: string }) => call<Project>("POST", "/api/projects", { ...b, opId: opId() }),
  updateProject: (id: Id, b: Partial<Pick<Project, "title" | "brief" | "personaId" | "modeId">>) => call<Project>("PATCH", `/api/projects/${id}`, b),
  deleteProject: (id: Id, confirm: string) => call<{ removed: string[]; caveat: string }>("POST", `/api/projects/${id}/delete`, { confirm }),
  addException: (id: Id, b: { ruleId: Id; note: string; approvedByWriter: boolean }) => call<Project>("POST", `/api/projects/${id}/exceptions`, b),
  removeException: (id: Id, eid: Id) => call<Project>("DELETE", `/api/projects/${id}/exceptions/${eid}`),
  drafts: (id: Id) => call<DraftMeta[]>("GET", `/api/projects/${id}/drafts`),
  draft: (vid: Id) => call<DraftVersion>("GET", `/api/drafts/${vid}`),
  saveDraft: (id: Id, b: { baseVersionId: Id | null; editorJson: unknown; origin?: string }) =>
    call<{ version: DraftVersion; unchanged: boolean }>("POST", `/api/projects/${id}/drafts`, { ...b, opId: opId() }),
  runs: (id: Id) => call<Run[]>("GET", `/api/projects/${id}/runs`),
  startRun: (id: Id, b: { task: "review" | "revise"; versionId: Id }) => call<Run>("POST", `/api/projects/${id}/runs`, b),
  run: (rid: Id) => call<Run>("GET", `/api/runs/${rid}`),
  cancelRun: (rid: Id) => call<{ note: string }>("POST", `/api/runs/${rid}/cancel`),

  previewImport: (b: { filename?: string; text?: string; base64?: string }) =>
    call<{ blocks: Example["blocks"]; sourceFormat: Example["sourceFormat"]; suggestedExclusions: Id[]; words: number }>("POST", "/api/examples/preview", b),
  addExample: (b: unknown) => call<Example>("POST", "/api/examples", { ...(b as object), opId: opId() }),
  updateExample: (id: Id, b: Partial<Example>) => call<Example>("PATCH", `/api/examples/${id}`, b),
  deleteExample: (id: Id, b: { alsoRetireDerivedRules: boolean; confirm: string }) =>
    call<{ removed: string[]; retiredRuleIds: Id[]; caveat: string }>("POST", `/api/examples/${id}/delete`, b),
};
