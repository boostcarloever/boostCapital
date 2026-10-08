import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/compiler";
import { executeRun, newRun, runLabel, type Judges, type VoiceVerdict } from "../src/core/runs";
import type { Block, Run } from "../src/core/types";
import { CONNECTED_RULE, EM_DASH_RULE, example, p, persona, project } from "./fixtures";

const usage = { model: "fake-model", inputTokens: 10, outputTokens: 5 };

function fakeJudges(overrides: Partial<Judges> = {}): Judges {
  return {
    available: () => true,
    voice: async () => ({ dimensions: [], findings: [], usage }),
    meaning: async () => ({ findings: [], usage }),
    revise: async () => ({ patches: [], usage }),
    ...overrides,
  };
}

function setup(blocks: Block[], judges: Judges, task: "review" | "revise" = "review", signal = new AbortController().signal) {
  const context = compileContext({ revision: persona([EM_DASH_RULE, CONNECTED_RULE]), project: project(), examples: [example({ id: "example_a" })], decisions: [] });
  const run: Run = newRun({ id: "run_1", projectId: "project_one", task, baseVersionId: "draft_base", personaRevision: "rev_002" }, "2026-10-06T00:00:00Z");
  let n = 0;
  const saved: Block[][] = [];
  return {
    run,
    saved,
    go: () =>
      executeRun(run, {
        judges,
        context,
        baseBlocks: blocks,
        signal,
        emit: async () => {},
        saveCandidate: async (b) => {
          saved.push(b);
          return `draft_c${++n}`;
        },
      }),
  };
}

describe("run state machine", () => {
  it("AT-17: without a processor, a run ends Checks incomplete, never ready", async () => {
    const { go } = setup([p("b1", "Clean prose.")], fakeJudges({ available: () => false }));
    const run = await go();
    expect(run.state).toBe("CHECKS_INCOMPLETE");
    expect(runLabel(run.state)).toBe("Checks incomplete");
    expect(run.sections.explicit_rules.status).toBe("complete");
    expect(run.sections.voice.status).toBe("unavailable");
    expect(run.usage.requests).toBe(0);
  });

  it("AT-18: a failing provider leaves checks incomplete with the reason", async () => {
    const { go } = setup([p("b1", "Clean prose.")], fakeJudges({ voice: async () => { throw new Error("provider down"); } }));
    const run = await go();
    expect(run.state).toBe("CHECKS_INCOMPLETE");
    expect(run.sections.voice.note).toMatch(/provider down/);
  });

  it("AT-09: keeps findings that resolve to exact text and valid rules; discards the rest", async () => {
    const verdict: VoiceVerdict = {
      dimensions: [{ dimension: "paragraph_development", result: "issue", reason: "" }],
      findings: [
        { dimension: "paragraph_development", rule_ids: ["rule_connected_argument"], evidence_ids: ["example_a"], block_id: "b1", quote: "Short.", explanation: "Disconnected.", proposed_action: "Connect it.", replacement: null },
        { dimension: "rhythm", rule_ids: ["rule_invented"], evidence_ids: [], block_id: "b1", quote: "Short.", explanation: "x", proposed_action: "x", replacement: null },
        { dimension: "rhythm", rule_ids: [], evidence_ids: [], block_id: "b1", quote: "not in the draft", explanation: "x", proposed_action: "x", replacement: null },
        { dimension: "rhythm", rule_ids: [], evidence_ids: ["example_nonexistent"], block_id: "b1", quote: "Short.", explanation: "x", proposed_action: "x", replacement: null },
      ],
      usage,
    };
    const { go } = setup([p("b1", "Short.")], fakeJudges({ voice: async () => verdict }));
    const run = await go();
    expect(run.findings.filter((f) => f.criterion === "voice")).toHaveLength(1);
    expect(run.rejectedFindings).toBe(3);
    expect(run.state).toBe("READY_FOR_REVIEW");
    expect(run.sections.meaning.status).toBe("not_applicable");
  });

  it("a mechanical blocker means Needs review, not ready", async () => {
    const { go } = setup([p("b1", "A dash—here.")], fakeJudges());
    const run = await go();
    expect(run.state).toBe("NEEDS_REVIEW");
  });

  it("AT-11: revision stops after two repair passes and rechecks each candidate", async () => {
    let calls = 0;
    const judges = fakeJudges({
      voice: async (blocks) => ({
        dimensions: [],
        findings: [{ dimension: "rhythm", rule_ids: [], evidence_ids: [], block_id: "b1", quote: blocks[0].text.split(" ")[0], explanation: "x", proposed_action: "x", replacement: null }],
        usage,
      }),
      revise: async (blocks) => {
        calls++;
        const word = blocks[0].text.split(" ")[0];
        return { patches: [{ blockId: "b1", find: word, replace: `${word}x`, findingIds: [] }], usage };
      },
    });
    const { go, saved } = setup([p("b1", "Alpha beta."), p("b2", "Locked.", { locked: true })], judges, "revise");
    const run = await go();
    expect(calls).toBe(2);
    expect(run.repairPasses).toBe(2);
    expect(run.candidateVersionIds).toEqual(["draft_c1", "draft_c2"]);
    expect(saved[1][0].text).toBe("Alphaxx beta.");
    expect(saved[1][1].text).toBe("Locked.");
    expect(run.evaluatedVersionId).toBe("draft_c2");
    expect(run.usage.requests).toBeLessThanOrEqual(12);
  });

  it("revision runs the meaning check against the original", async () => {
    const judges = fakeJudges({
      voice: async (blocks) => ({
        dimensions: [],
        findings: blocks[0].text.includes("may")
          ? [{ dimension: "register", rule_ids: [], evidence_ids: [], block_id: "b1", quote: "may", explanation: "x", proposed_action: "x", replacement: null }]
          : [],
        usage,
      }),
      revise: async () => ({ patches: [{ blockId: "b1", find: "may rise 4%", replace: "will rise 9%", findingIds: [] }], usage }),
    });
    const { go } = setup([p("b1", "Costs may rise 4%.")], judges, "revise");
    const run = await go();
    const meaning = run.findings.filter((f) => f.criterion === "meaning");
    expect(meaning.map((f) => f.dimension)).toEqual(expect.arrayContaining(["number_changed", "qualifier_removed"]));
    expect(run.state).toBe("NEEDS_REVIEW");
  });

  it("cancellation stops new stages and labels the run Stopped", async () => {
    const controller = new AbortController();
    const judges = fakeJudges({
      voice: async () => {
        controller.abort();
        return { dimensions: [], findings: [], usage };
      },
    });
    const { go } = setup([p("b1", "Text.")], judges, "review", controller.signal);
    const run = await go();
    expect(run.state).toBe("CANCELED");
    expect(runLabel(run.state)).toBe("Stopped");
  });
});
