/**
 * Local HTTP surface for the web build. Binds to 127.0.0.1 only and exposes
 * named operations; there is no general file, shell, or SQL endpoint.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnikaError, type ErrorCode } from "../src/core/types";
import { ClaudeJudges } from "./llm";
import { Repo } from "./repo";
import { Service } from "./service";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const PORT = Number(process.env.ANIKA_PORT ?? 4317);
const ROOT = process.env.ANIKA_WORKSPACE ?? path.resolve(here, "..", "workspace");

const STATUS: Partial<Record<ErrorCode, number>> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  UNSUPPORTED_IMPORT: 415,
  VERSION_CONFLICT: 409,
  STALE_PATCH: 409,
  PROFILE_CONFLICT: 409,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 413,
  CHECKS_UNAVAILABLE: 503,
  NETWORK_UNAVAILABLE: 503,
  STORAGE_UNAVAILABLE: 507,
};

/** Every error maps to a non-destructive recovery action shown in the UI. */
const RECOVERY: Partial<Record<ErrorCode, string>> = {
  VERSION_CONFLICT: "Reload to see the latest version. Nothing you wrote was discarded.",
  STALE_PATCH: "Run the check again on the current text.",
  PROFILE_TOO_LARGE: "Open Your voice and consolidate overlapping rules.",
  PROFILE_MISSING: "Create or reconnect a persona.",
  CHECKS_UNAVAILABLE: "Keep writing; your draft is saved. Model checks will run once a processor is available.",
  NETWORK_UNAVAILABLE: "Keep writing offline; run the check again when you are connected.",
  RATE_LIMITED: "Wait a minute and run the check again.",
  UNSUPPORTED_IMPORT: "Paste the text instead.",
  STORAGE_UNAVAILABLE: "Check that the workspace folder exists and is writable, then reconnect.",
  BUDGET_EXCEEDED: "Check one section at a time.",
};

async function main() {
  const repo = await Repo.open(ROOT);
  const service = new Service(repo, new ClaudeJudges());
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  const h =
    (fn: (req: Request, res: Response) => unknown) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out ?? { ok: true });
      } catch (err) {
        next(err);
      }
    };
  const p = (req: Request, key: string) => String(req.params[key]);

  app.get("/api/state", h(() => service.state()));

  app.post("/api/personas", h((req) => service.createPersona(req.body)));
  app.get("/api/personas/:pid/revisions", h((req) => repo.revisions.get(p(req, "pid")) ?? []));
  app.post("/api/personas/:pid/modes", h((req) => service.addMode(p(req, "pid"), req.body)));
  app.post("/api/personas/:pid/policy", h((req) => service.setLearningPolicy(p(req, "pid"), req.body)));
  app.post("/api/personas/:pid/rules", h((req) => service.addRule(p(req, "pid"), req.body)));
  app.post("/api/personas/:pid/rules/:rid", h((req) => service.updateRule(p(req, "pid"), p(req, "rid"), req.body)));
  app.post("/api/personas/:pid/rules/:rid/retire", h((req) => service.retireRule(p(req, "pid"), p(req, "rid"), req.body)));
  app.post("/api/personas/:pid/restore", h((req) => service.restore(p(req, "pid"), req.body)));
  app.post("/api/personas/:pid/profile", h((req) => service.proposeProfile(p(req, "pid"), req.body.modeId)));
  app.get(
    "/api/personas/:pid/export",
    h((req, res) => {
      const bundle = service.exportPersona(p(req, "pid"), { examples: req.query.examples !== "0", projects: req.query.projects !== "0" });
      res.setHeader("Content-Disposition", `attachment; filename="anika-${p(req, "pid")}.anika.json"`);
      res.json(bundle);
    }),
  );
  app.post("/api/import/plan", h((req) => service.importPlan(req.body)));
  app.post("/api/import/apply", h((req) => service.importApply(req.body)));

  app.post("/api/proposals/:id/approve", h((req) => service.approveProposal(p(req, "id"), req.body)));
  app.post("/api/proposals/:id/approve-partial", h((req) => service.approvePartial(p(req, "id"), req.body)));
  app.post("/api/proposals/:id/reject", h((req) => service.rejectProposal(p(req, "id"))));

  app.post("/api/feedback", h((req) => service.proposeCorrection(req.body)));
  app.post("/api/findings/feedback", h((req) => service.evaluatorFeedback(req.body)));

  app.post("/api/projects", h((req) => service.createProject(req.body)));
  app.patch("/api/projects/:id", h((req) => service.updateProject(p(req, "id"), req.body)));
  app.post("/api/projects/:id/delete", h((req) => service.deleteProject(p(req, "id"), req.body)));
  app.post("/api/projects/:id/exceptions", h((req) => service.addException(p(req, "id"), req.body)));
  app.delete("/api/projects/:id/exceptions/:eid", h((req) => service.removeException(p(req, "id"), p(req, "eid"))));
  app.get("/api/projects/:id/drafts", h((req) => service.listDrafts(p(req, "id"))));
  app.post("/api/projects/:id/drafts", h((req) => service.saveDraft(p(req, "id"), req.body)));
  app.get("/api/projects/:id/runs", h((req) => service.listRuns(p(req, "id"))));
  app.post("/api/projects/:id/runs", h((req) => service.startRun(p(req, "id"), req.body)));
  app.get("/api/projects/:id/context", h((req) => service.compile(p(req, "id")).manifest));
  app.get("/api/drafts/:id", h((req) => service.getDraft(p(req, "id"))));
  app.get(
    "/api/runs/:id",
    h((req) => {
      const run = repo.runs.get(p(req, "id"));
      if (!run) throw new AnikaError("NOT_FOUND", "Run not found.");
      return run;
    }),
  );
  app.post("/api/runs/:id/cancel", h((req) => service.cancelRun(p(req, "id"))));

  app.post("/api/examples/preview", h((req) => service.previewImport(req.body)));
  app.post("/api/examples", h((req) => service.addExample(req.body)));
  app.patch("/api/examples/:id", h((req) => service.updateExample(p(req, "id"), req.body)));
  app.post("/api/examples/:id/delete", h((req) => service.deleteExample(p(req, "id"), req.body)));

  app.use("/api", (_req, res) => res.status(404).json({ code: "NOT_FOUND", message: "No such operation." }));

  const dist = path.resolve(here, "..", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AnikaError) {
      res.status(STATUS[err.code] ?? 422).json({ code: err.code, message: err.message, recovery: RECOVERY[err.code] ?? null, detail: err.detail ?? null });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ code: "INVALID_INPUT", message: "Malformed request." });
      return;
    }
    console.error(err);
    res.status(500).json({ code: "STORAGE_UNAVAILABLE", message: "Something went wrong saving or reading your workspace.", recovery: RECOVERY.STORAGE_UNAVAILABLE });
  });

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Anika workspace: ${repo.root}`);
    console.log(`Model processor: ${service.judges.available() ? "configured" : "not configured (model checks will report unavailable)"}`);
    console.log(`Listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
