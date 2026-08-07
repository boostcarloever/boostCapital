# Interview Guide

This document is presentation prep. The actual assessment outputs live in `outputs/`, `logs/`, `data/benchmarks/`, and `data/intermediate/`. Use this guide to understand the work end to end and explain it clearly.

## One-Minute Summary

This project answers:

```text
I have a budget of $10. I want chicken, some vegetables, and a couple of beers.
What should I order, and from where?
```

I treated the task as a time-boxed menu intelligence problem, not a perfect OCR challenge. The main goal was to produce a recommendation that cites the source menu and observed prices, while honestly documenting what I do and do not trust.

The final recommendation is from the Rainbow / ឥន្ទធនូ menu set:

| Item | Price |
|---|---:|
| Chicken rice | `8000៛` |
| Roasted lotus root | `12000៛` |
| Anchor beer | `3,000៛` |
| Anchor beer | `3,000៛` |

Total: `26000៛`, about `$6.50` using `4,000៛ = $1`.

## What The Assessment Asked For

The prompt asked for seven things:

1. A written plan at the 15-minute mark.
2. A prediction of extraction accuracy before processing.
3. An assumptions list.
4. A recommendation with provenance.
5. A "what I don't trust" section with revised accuracy estimate.
6. Debrief notes for a short conversation.
7. GitHub repo evidence, benchmarks, and AI usage trail.

The repo has an artifact for each of those.

## What I Built

I built a small evidence-first workflow:

- A source manifest so long screenshot filenames have stable IDs like `menu_005`.
- A reusable OpenRouter vision extraction script.
- Raw JSONL outputs from OCR/model calls.
- Benchmark notes comparing model behavior.
- Cropped source evidence for the final recommendation.
- Markdown deliverables for plan, assumptions, recommendation, critique, and debrief.

I avoided building a UI, database, or full production pipeline because those would not improve the assessment score as much as provenance and honesty.

## Important File Map

| File or folder | What it does |
|---|---|
| `README.md` | Quick repo entrypoint for reviewers. |
| `AGENTS.md` | Operating guide for coding agents in this assessment repo. |
| `outputs/plan.md` | Required 15-minute written plan plus pre-run accuracy prediction. |
| `outputs/assumptions.md` | Required assumptions list. |
| `outputs/recommendation.md` | Final recommendation, source citations, prices, total, and budget fit. |
| `outputs/what-i-dont-trust.md` | Ranked weaknesses and revised accuracy estimate. |
| `outputs/debrief.md` | What I would do differently and how this changes at scale. |
| `logs/ai-usage.md` | Required AI usage trail. |
| `data/manifest.csv` | Stable IDs for the original menu screenshots. |
| `data/crops_manifest.csv` | Stable IDs for manually cropped evidence images. |
| `data/crops/` | Crops used to strengthen provenance for final selected items. |
| `data/intermediate/extractions.jsonl` | Initial smoke-test extraction output. |
| `data/intermediate/extractions_full.jsonl` | Main raw OCR/model output. |
| `data/intermediate/validation_models.jsonl` | Failed extra-model validation attempts, preserved as evidence. |
| `data/intermediate/crop_validation.jsonl` | Failed crop OCR attempt at high token limit. |
| `data/intermediate/crop_validation_low_tokens.jsonl` | Successful low-token crop OCR validation. |
| `data/benchmarks/README.md` | Benchmark plan and commands. |
| `data/benchmarks/ocr-results.md` | Benchmark results and model comparison. |
| `scripts/extract_menus.py` | Reproducible OpenRouter extraction script. |

## Source IDs

The original filenames are long screenshots, so I created `data/manifest.csv` to make them easier to cite.

The most important mapping:

| Source ID | Original file |
|---|---|
| `menu_005` | `data/Screenshot 2026-07-21 at 11.15.08 AM.png` |
| `menu_006` | `data/Screenshot 2026-07-21 at 11.15.15 AM.png` |
| `menu_007` | `data/Screenshot 2026-07-21 at 11.15.26 AM.png` |

The final answer uses `menu_005` for food, `menu_006` for beer, and `menu_007` to support the Rainbow / ឥន្ទធនូ restaurant identity.

## Process Timeline

### 1. Planning

I first wrote the plan before processing menu content:

- `outputs/plan.md`
- `outputs/assumptions.md`
- `logs/ai-usage.md`

The plan predicted:

- Item names: 60-75%
- Prices: 80-90%
- Currency: 70-85%
- Category classification: 70-80% after manual verification
- End-to-end recommendation reliability: 65-75%

This matters because the prompt explicitly asks for the accuracy prediction before processing.

### 2. Data Inventory

The prompt said approximately 30 menus, but the local `data/` folder had 10 PNG screenshots. I documented this as an assumption instead of pretending the count matched.

I created:

- `data/manifest.csv`

This gives every screenshot a stable `menu_###` ID.

### 3. Model Selection

I used:

- `google/gemini-3-flash-preview` as the primary OCR/extraction model.
- `qwen/qwen3-vl-235b-a22b-instruct` as the challenger model.

Reasoning:

- Gemini 3 Flash was expected to be fast, cheap, and strong at general OCR.
- Qwen3-VL was worth testing because it is strong on multilingual vision/OCR tasks and Asian scripts.

Later, I attempted targeted validation with:

- `openai/gpt-4o`
- `anthropic/claude-sonnet-4-6`
- `google/gemini-2.5-flash`

Those attempts failed due to OpenRouter credit limits. I kept the raw error outputs and documented the failure instead of hiding it.

### 4. Extraction Script

The main script is:

```text
scripts/extract_menus.py
```

It:

- Reads a manifest CSV.
- Converts PNGs into base64 image data URLs.
- Sends each image to OpenRouter.
- Requests structured JSON.
- Saves raw responses as JSONL.
- Keeps model name, source ID, prompt, raw response, and extracted text.

The important thing is that raw outputs are preserved. I did not only keep cleaned results.

### 5. Smoke Test

I first ran one image through both default models:

```powershell
uv run python scripts\extract_menus.py --limit 1
```

Output:

```text
data/intermediate/extractions.jsonl
```

Result:

- Both models responded.
- Gemini found restaurant name and richer price context.
- Qwen often returned cleaner JSON, but simplified some prices.

### 6. Full Extraction

Then I ran the extraction across the dataset:

```powershell
uv run python scripts\extract_menus.py --output data\intermediate\extractions_full.jsonl
```

The full run timed out once, but the script writes one JSONL record at a time, so partial results were preserved.

I added `--source-id` support to resume only missing menus without reprocessing everything.

Completed evidence:

```text
data/intermediate/extractions_full.jsonl
```

Known issue:

- The file contains duplicates from resumed runs.
- This is acceptable because it preserves raw evidence.
- Benchmark summaries must dedupe by `source_id + model`.

### 7. Candidate Selection

I parsed the raw model text and searched for target categories:

- Chicken candidates
- Vegetable candidates
- Beer candidates

Strong candidates found:

- `menu_005`: Chicken rice at `8000៛`
- `menu_005`: Roasted lotus root at `12000៛`
- `menu_006`: Anchor beer at `3,000៛`
- `menu_007`: Rainbow / ឥន្ទធនូ restaurant identity

Alternative candidate:

- Reatry Battambong had USD chicken/vegetable food items, but no beer page in the provided screenshots.

### 8. Manual Visual Check

I visually inspected key source images:

- `menu_005` for food prices.
- `menu_006` for beer prices.
- `menu_007` for Rainbow identity.
- `menu_009` and `menu_010` for Reatry Battambong as a backup.

This is important: the recommendation is not based only on model output. It is model-assisted plus manual verification.

### 9. Crop Evidence

To strengthen provenance, we created cropped images:

| Crop ID | File | Purpose |
|---|---|---|
| `crop_001` | `data/crops/menu_005_chicken_rice.png` | Chicken rice evidence. |
| `crop_002` | `data/crops/menu_005_roasted_lotus_root.png` | Roasted lotus root / vegetable evidence. |
| `crop_003` | `data/crops/menu_006_anchor_beer.png` | Anchor beer evidence. |
| `crop_004` | `data/crops/menu_007_rainbow_identity.png` | Rainbow identity evidence. |

The crop manifest is:

```text
data/crops_manifest.csv
```

### 10. Crop OCR Validation

The first crop OCR command failed because OpenRouter credits could not cover `max_tokens=4000`.

I updated the script to support:

```text
--max-tokens
```

Then we ran a lower-token crop validation:

```powershell
uv run python scripts\extract_menus.py --manifest data\crops_manifest.csv --output data\intermediate\crop_validation_low_tokens.jsonl --models google/gemini-3-flash-preview --limit 4 --max-tokens 800
```

Results:

- `crop_001`: confirmed Chicken Rice at `8000៛`.
- `crop_003`: confirmed Anchor Beer at `3.000៛`.
- `crop_004`: confirmed restaurant name as `ឥន្ទធនូ (Rainbow)`.
- `crop_002`: truncated before a clean confirmation of roasted lotus root at `12000៛`.

So the vegetable item remains the weakest final citation, and that is documented in `outputs/what-i-dont-trust.md`.

## Final Recommendation Logic

The final selected combination:

| Need | Item | Source | Price |
|---|---|---|---:|
| Chicken | Chicken rice | `menu_005` | `8000៛` |
| Vegetables | Roasted lotus root | `menu_005` | `12000៛` |
| Beer | Anchor beer | `menu_006` | `3,000៛` |
| Beer | Anchor beer | `menu_006` | `3,000៛` |

Math:

```text
8000៛ + 12000៛ + 3000៛ + 3000៛ = 26000៛
26000៛ / 4000 = $6.50
Budget remaining = about $3.50
```

Why this answer:

- It satisfies chicken, vegetables, and two beers.
- It stays comfortably under `$10`.
- It uses adjacent pages from the same apparent menu set.
- It has better budget margin than the USD Reatry Battambong backup.

## Main Caveats

Lead with these honestly.

1. Restaurant grouping is inferred.
   - `menu_005` and `menu_006` do not visibly show the restaurant name.
   - `menu_007` confirms Rainbow / ឥន្ទធនូ on an adjacent page.
   - I infer the pages belong together based on sequence and menu style.

2. Vegetable item is the weakest citation.
   - The original full-menu Gemini extraction found roasted lotus root at `12000៛`.
   - Manual crop inspection supports the price area.
   - Low-token crop OCR truncated before a clean final confirmation.

3. Raw Khmer OCR is not fully trustworthy.
   - English guesses and visible price checks were more reliable than raw Khmer text.
   - Item names should be verified by a Khmer reader if this were production.

4. Extra validation models failed.
   - GPT-4o, Claude Sonnet, and Gemini 2.5 Flash were attempted.
   - OpenRouter returned `402 Payment Required`.
   - The failure is logged in `validation_models.jsonl` and `logs/ai-usage.md`.

## How To Talk Through The Project

Use this flow:

1. "I started by writing the plan and accuracy prediction before processing data, because that was explicitly required."
2. "I created a manifest so every menu screenshot had a stable source ID."
3. "I ran Gemini 3 Flash and Qwen3-VL as the main OCR/extraction models."
4. "I preserved raw outputs in JSONL, including duplicates and failed calls."
5. "I filtered for chicken, vegetable, and beer candidates instead of trying to extract every menu perfectly."
6. "I manually checked the source images for the final rows."
7. "I created crops for the selected evidence and reran low-token OCR on those crops."
8. "The final answer is under budget, but I documented the weak points, especially restaurant grouping and the vegetable row."

## Likely Interview Questions

### Why not build a UI?

Because the prompt is about reasoning under a 3-hour time limit. A UI would not improve extraction accuracy or provenance. Plain Markdown and JSONL are easier to audit.

### Why use two OCR models?

Because Khmer OCR is hard and model disagreement is useful. Gemini was the primary model because it completed all pages; Qwen was a challenger and cross-check.

### Why did you keep duplicate/error records?

Because this assessment values process evidence. Deleting failed calls would make the trail less honest. I documented that summaries need deduping.

### Why is the recommendation not from Reatry Battambong?

Reatry Battambong has named USD food pages, but I did not find a beer page for that restaurant in the provided screenshots. The Rainbow menu set had food and beer pages that supported the whole order under budget.

### What would you verify first with more time?

I would verify that `menu_005`, `menu_006`, and `menu_007` are from the same physical restaurant menu. Then I would ask a Khmer reader or run better cropped OCR on the roasted lotus root row.

### How would this scale?

I would build a pipeline with image inventory, OCR, crop-based row extraction, structured parsing, confidence scoring, human review queues, and a retrieval layer for source citations. I would also label a ground-truth benchmark set.

## What To Avoid Saying

- Do not claim the OCR is perfect.
- Do not claim all menus were extracted completely.
- Do not claim GPT-4o, Claude, or Gemini 2.5 validated the answer; those calls failed due to credits.
- Do not hide that the dataset locally had 10 screenshots, while the prompt said approximately 30 menus.
- Do not overstate the vegetable item confidence.

## Strong Closing

The strongest framing is:

```text
I made a defensible recommendation under the time limit by prioritizing provenance and uncertainty tracking over complete OCR. The answer is useful, under budget, and traceable, but I would verify the page grouping and the vegetable row first before treating it as production-grade.
```
