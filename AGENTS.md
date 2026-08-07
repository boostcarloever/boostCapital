# AGENTS.md

This file gives coding agents a fast, reliable operating guide for this repository.

## Project Snapshot

- Project: VerifyIQ AI Engineering Assessment - Khmer Menu Intelligence
- Language: Python `>=3.13`
- Package manager / runner: `uv`
- Current app shape: small Python assessment workspace using `python-dotenv`, `requests`, and OpenRouter via `OPENROUTER_API_KEY`
- Main domain: Khmer menu extraction, messy/scanned menu understanding, provenance-backed food recommendation
- Time box: 3 hours total across planning, extraction, recommendation, critique, logs, benchmarks, and repo hygiene

This is an assessment project. The goal is not a perfect answer. The goal is to show clear prioritization, traceable evidence, and an honest assessment of what can and cannot be trusted under tight time pressure.

## Assessment Task

Given roughly 30 Cambodian restaurant menus, all in Khmer and likely messy or scanned, build something that answers:

```text
I have a budget of $10. I want chicken, some vegetables, and a couple of beers.
What should I order, and from where?
```

There are no restrictions on tools, models, APIs, or libraries. Working code is welcome, but hand verification is acceptable when it is explicitly labeled.

## What Is Being Evaluated

- How the work is prioritized under a tight time box.
- What is chosen for implementation versus explicitly skipped.
- Whether the final output honestly assesses its own trustworthiness.
- Whether each claim can be traced back to a source menu and observed price.

A rough, defensible result with clearly stated weaknesses is better than a polished answer that cannot be explained.

## Repo Map

- `main.py`: current minimal OpenRouter API smoke test.
- `pyproject.toml`: Python version and dependency metadata.
- `uv.lock`: locked dependency state.
- `.env.example`: example environment variables.
- `.env`: local secrets; do not commit.
- `README.md`: project notes, final summary, or handoff material if needed.

Likely assessment artifacts:

- `data/raw/`: original menu files, screenshots, OCR text, or other untouched source inputs.
- `data/intermediate/`: extracted menu rows, model outputs, OCR outputs, and cleaned working files.
- `data/benchmarks/`: benchmark scripts, benchmark inputs, raw outputs, and scoring notes.
- `scripts/`: parsing, extraction, scoring, and recommendation scripts.
- `outputs/`: written plan, assumptions, recommendation, critique, and debrief notes.
- `logs/`: AI prompts, transcripts, tool calls, timing notes, and manual review notes.

Only create these folders when they are useful for traceability or deliverables.

## Local Setup

```bash
uv sync
```

Run the current smoke test:

```bash
uv run python main.py
```

Required local environment variable:

```bash
OPENROUTER_API_KEY=...
```

Never print, paste, or commit the real API key.

## Quality Gates

Use lightweight checks that fit the assessment time box.

For the current script:

```bash
uv run python main.py
```

If tests are added:

```bash
uv run pytest
```

If formatters or linters are added later, document the exact commands in `README.md`.

## Required Deliverables

1. Written plan due at the 15 minute mark: 2-3 paragraphs covering approach, fallback if it fails, and what is explicitly not being done because of time.
2. Accuracy prediction in the plan before processing anything: expected extraction accuracy for item names, prices, and currency.
3. Assumptions list: every assumption about the task, data, menus, prices, currency, exchange rates, and recommendation criteria.
4. Recommendation with provenance: every recommended item must cite source menu and price as it appears there. Show total and how it fits the $10 budget.
5. "What I don't trust" section: ranked list of weakest points, likely misread menus, questionable prices, what to verify first with more time, revised accuracy estimate, and why it differs from the prediction.
6. Debrief preparation: what would change on a second attempt and how the approach changes at much larger scale.
7. GitHub repo evidence: commit as work progresses, keep raw benchmark numbers and scripts, and save prompts, transcripts, and tool logs.

## Time-Boxed Workflow

Suggested split for the 3 hour assessment:

- 0-15 min: inspect data, write the plan, assumptions, explicit non-goals, and pre-run accuracy prediction.
- 15-55 min: build the thinnest extraction path that preserves source references.
- 55-95 min: extract candidate items and prices, normalize only when needed, and flag uncertainty.
- 95-130 min: manually verify the best chicken, vegetable, and beer candidates against source menus.
- 130-160 min: write the recommendation with exact provenance and budget total.
- 160-180 min: write the trust critique, revised accuracy estimate, debrief notes, and commit final artifacts.

If behind schedule, stop expanding automation and switch to labeled manual verification.

## Accuracy And Provenance Rules

- State expected accuracy before processing menu data.
- Preserve raw extraction/model/OCR output next to cleaned or normalized data.
- Track source menu, page/image reference when available, observed item text, observed price, currency, extraction method, normalized value, and confidence.
- Do not silently repair Khmer text, prices, or currencies.
- Keep original observed values separate from normalized interpretations.
- Every final recommendation item needs source menu plus observed price.
- If a claim cannot be traced, mark it uncertain or exclude it from the recommendation.

## Recommendation Rules

The requested order should satisfy:

- Budget: `$10`
- Food intent: chicken
- Food intent: some vegetables
- Drink intent: a couple of beers

When recommending:

- Prefer one restaurant if it can satisfy the whole order within budget.
- Use multiple restaurants only if needed, and say why.
- Show observed prices exactly as found.
- Show any normalized USD estimate separately.
- State exchange-rate or currency assumptions if menus use Cambodian riel or mixed currencies.
- Do not overclaim that an item is chicken, vegetable, or beer when the Khmer extraction is ambiguous.

## AI Usage Trail And Benchmarks

This is mandatory assessment evidence, not optional cleanup.

For each AI-assisted or tool-assisted step, log:

- Timestamp
- Tool or model used
- Prompt or instruction
- Source input
- Output file or result
- Manual corrections
- Known limitations

Recommended log location:

```bash
logs/ai-usage.md
```

Recommended benchmark location:

```bash
data/benchmarks/
```

Benchmarks can be rough. Preserve scripts, inputs, raw outputs, and scoring notes.

## Coding Expectations

- Keep scripts simple, inspectable, and reproducible.
- Prefer plain text, Markdown, CSV, or JSONL for assessment evidence.
- Separate extraction from normalization and recommendation selection.
- Keep source identifiers in every row or record.
- Label manual verification clearly.
- Avoid broad refactors or architecture work that does not directly help the deliverables.
- Favor a partial but traceable recommendation over a broader unsupported one.

## Explicit Non-Goals

Unless there is spare time, do not prioritize:

- Perfect Khmer OCR.
- Complete menu catalog extraction.
- Sophisticated UI.
- Production database design.
- Large-scale ingestion infrastructure.
- Exhaustive restaurant ranking.
- Complex optimization beyond a defensible under-budget recommendation.

Mention skipped work in the plan and debrief.

## Git And Evidence Discipline

- Commit meaningful checkpoints as work progresses.
- Keep raw benchmark numbers, benchmark scripts, prompts, transcripts, and tool logs.
- Do not commit `.env`, API keys, or secrets.
- Before final handoff, run:

```bash
git status --short
```

## Safety Notes

- Avoid committing secrets, credentials, or raw private tokens.
- Treat API calls as billable and log them.
- Use clarifying questions when they materially reduce assessment risk.
- Keep outputs honest about uncertainty, especially for Khmer OCR and price interpretation.

## Mandatory Rules

### 1. Describe Before You Code
- State your approach and wait for approval before writing any code.
- If requirements are ambiguous, ask clarifying questions first.
- If multiple interpretations exist, present them and ask which to proceed with.

### 2. Limit Scope
- If a task touches more than **3 files**, stop.
- Break it into smaller subtasks and present the breakdown for approval.

### 3. Surgical Changes Only
- Change only what the request requires. Nothing more.
- Do not refactor, reformat, or clean up unrelated code.
- Mention unrelated issues as comments; never fix them silently.

### 4. Post-Code Risk Review
- After every code change, list what could break.
- Suggest tests that cover the risk areas.

### 5. Bug Fix Protocol
- Reproduce the bug with a failing test first.
- Fix the code until the test passes.
- Fix root causes; never patch symptoms.

### 6. Terminal Execution Protocol
- Always run commands asynchronously when supported (for example `wait=false`).
- Immediately follow with a separate read/status check (for example `read-process`, `wait=true`).
- Use appropriate timeouts: 60s for quick checks, 600s for builds.

### 7. Codebase Exploration Protocol
- Always use the available codebase retrieval tool before reading individual files.
- Use the current project's root directory as the search context.
- Never assume file locations; always explore first.

### 8. Learn From Corrections
- When the user corrects the agent, add a rule to `AGENTS.md` so the mistake never repeats.

## Code Quality Standards

- Follow language conventions (PEP 8 for Python).
- Prefer explicit over implicit; no magic, no clever tricks.
- Keep functions small and single-purpose.
- Write type hints on all function signatures.
- Add docstrings to all public functions and classes.
- No hardcoded secrets, credentials, or environment-specific paths.
- Configuration lives in config files or environment variables.

## Quality Priority Order

```text
Correctness > Simplicity > Maintainability > Performance
```

If the solution is hard to explain, hard to debug, or hard to reproduce, it is wrong.

## Pre-Submit Self-Check

Before presenting any code output, verify:

- [ ] Did I describe my approach and get approval?
- [ ] Did I change only what was required?
- [ ] Did I list what could break?
- [ ] Are there hardcoded values, secrets, or magic numbers?
- [ ] Is this the simplest solution that works?
- [ ] Would a senior engineer call this overcomplicated?
