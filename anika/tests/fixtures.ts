import type { Block, Example, PersonaRevision, Project, Rule } from "../src/core/types";
import { firstRevision, nextRevision } from "../src/core/learning";

export const AT = "2026-10-06T09:00:00.000Z";

export function rule(partial: Partial<Rule> & Pick<Rule, "id" | "statement">): Rule {
  return {
    dimension: "general",
    scope: { kind: "core" },
    strength: "preference",
    status: "active",
    origin: "user_written",
    evidenceLevel: "explicit",
    evidence: [],
    exceptions: [],
    checker: { kind: "llm_rubric", criterion: partial.statement },
    createdAt: AT,
    updatedAt: AT,
    ...partial,
  };
}

export function persona(rules: Rule[]): PersonaRevision {
  const first = firstRevision(
    { id: "persona_carlo", name: "Carlo", learningPolicy: "review", languages: ["en"] },
    [
      { id: "mode_essay", name: "Opinion essay", description: "Long-form argument." },
      { id: "mode_email", name: "Client email", description: "Short business correspondence." },
    ],
    AT,
  );
  return nextRevision(first, { rules }, "seed", "user", AT);
}

export function project(partial: Partial<Project> = {}): Project {
  return {
    id: "project_one",
    personaId: "persona_carlo",
    modeId: "mode_essay",
    title: "On paragraphs",
    brief: "Argue for connected paragraphs.",
    exceptions: [],
    head: null,
    createdAt: AT,
    updatedAt: AT,
    ...partial,
  };
}

export function example(partial: Partial<Example> & Pick<Example, "id">): Example {
  return {
    personaId: "persona_carlo",
    title: partial.id,
    blocks: [{ id: `${partial.id}_b1`, kind: "paragraph", text: `Prose from ${partial.id}. It develops one idea across sentences.` }],
    provenance: "i_wrote",
    modeId: null,
    language: "en",
    status: "approved",
    excludedBlockIds: [],
    highlights: [],
    familyId: `family_${partial.id}`,
    split: "profile",
    textHash: `hash_${partial.id}`,
    sourceFormat: "paste",
    createdAt: AT,
    ...partial,
  };
}

export const p = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, kind: "paragraph", text, ...extra });

export const EM_DASH_RULE = rule({
  id: "rule_no_em_dash",
  statement: "Never use em dashes.",
  strength: "hard",
  checker: { kind: "forbidden_chars", chars: ["—"], regions: "author_prose" },
});

export const CONNECTED_RULE = rule({
  id: "rule_connected_argument",
  statement: "Develop long-form arguments in connected paragraphs.",
  scope: { kind: "mode", modeIds: ["mode_essay"] },
});
