# AI Usage Trail

This log is part of the assessment submission. Add one entry for every model-assisted extraction, translation, classification, summarization, benchmark, or manual correction step.

## Entries

### 2026-08-07 - Planning

- Tool/model used: Codex
- Purpose: Draft assessment operating plan, assumptions, and model strategy before processing menu content.
- Input source: User-provided assessment prompt and local repository context.
- Output files:
  - `outputs/plan.md`
  - `outputs/assumptions.md`
  - `logs/ai-usage.md`
- Notes:
  - No menu OCR or recommendation extraction has been run yet.
  - Pre-processing accuracy prediction is recorded in `outputs/plan.md`.

### 2026-08-07 - OCR smoke test

- Tool/model used:
  - `google/gemini-3-flash-preview`
  - `qwen/qwen3-vl-235b-a22b-instruct`
- Prompt/instruction: Structured Khmer menu extraction prompt in `scripts/extract_menus.py`.
- Input source: `menu_001` from `data/manifest.csv`.
- Output file/result: `data/intermediate/extractions.jsonl`.
- Manual corrections: None.
- Known limitations:
  - Gemini wrapped JSON in a Markdown code fence.
  - Qwen returned cleaner JSON but simplified some two-price rows.

### 2026-08-07 - Full OCR extraction

- Tool/model used:
  - `google/gemini-3-flash-preview`
  - `qwen/qwen3-vl-235b-a22b-instruct`
- Prompt/instruction: Structured Khmer menu extraction prompt in `scripts/extract_menus.py`.
- Input source: `menu_001` through `menu_010` from `data/manifest.csv`.
- Output file/result: `data/intermediate/extractions_full.jsonl`.
- Manual corrections:
  - The first full run timed out and was resumed using `--source-id`.
  - Duplicate records were left in the raw JSONL instead of deleting evidence.
  - Final recommendation was manually checked against the relevant PNG images.
- Known limitations:
  - Qwen returned `finish_reason=length` for `menu_006` and `menu_008`.
  - Interrupted/resumed runs produced duplicate records and a few error records.
  - Total recorded API cost including duplicate calls was about `$0.126`.

### 2026-08-07 - Recommendation drafting

- Tool/model used: Codex
- Prompt/instruction: Use extracted model outputs plus manual image inspection to draft recommendation and trust critique.
- Input source:
  - `data/intermediate/extractions_full.jsonl`
  - `data/Screenshot 2026-07-21 at 11.15.08 AM.png`
  - `data/Screenshot 2026-07-21 at 11.15.15 AM.png`
  - `data/Screenshot 2026-07-21 at 11.15.26 AM.png`
  - `data/Screenshot 2026-07-21 at 11.16.25 AM.png`
  - `data/Screenshot 2026-07-21 at 11.16.46 AM.png`
- Output files:
  - `outputs/recommendation.md`
  - `outputs/what-i-dont-trust.md`
- Manual corrections:
  - Preferred the Rainbow menu-set recommendation because it stays well under budget and uses adjacent pages from the same apparent menu set.
  - Kept the restaurant-name/page-grouping uncertainty explicit.
- Known limitations:
  - Restaurant identity for the main recommendation is inferred from an adjacent page.
  - Khmer item names still need native-speaker verification for maximum confidence.

### 2026-08-07 - Failed targeted validation pass

- Tool/model used:
  - `openai/gpt-4o`
  - `anthropic/claude-sonnet-4-6`
  - `google/gemini-2.5-flash`
- Prompt/instruction: Same structured Khmer menu extraction prompt in `scripts/extract_menus.py`.
- Input source:
  - `menu_005`
  - `menu_006`
  - `menu_007`
- Output file/result: `data/intermediate/validation_models.jsonl`.
- Manual corrections:
  - No model output was incorporated into the recommendation because every validation call failed.
- Known limitations:
  - OpenRouter returned `402 Payment Required` for all nine calls because remaining credits could not cover `max_tokens=4000`.
  - A better low-credit validation attempt would crop only the final candidate rows and request a short yes/no provenance check with a much lower token limit.

### 2026-08-07 - Manual crop evidence review

- Tool/model used: Codex visual inspection
- Prompt/instruction: Inspect user-created crops for the final recommendation evidence.
- Input source:
  - `data/crops/menu_005_chicken_rice.png`
  - `data/crops/menu_005_roasted_lotus_root.png`
  - `data/crops/menu_006_anchor_beer.png`
  - `data/crops/menu_007_rainbow_identity.png`
- Output files:
  - `outputs/recommendation.md`
  - `outputs/what-i-dont-trust.md`
  - `logs/ai-usage.md`
- Manual corrections:
  - Added crop paths as manual provenance evidence.
- Known limitations:
  - The `menu_005` crops still include multiple rows, so they are supporting evidence rather than perfect single-row citations.

### 2026-08-07 - Low-token crop OCR validation

- Tool/model used: `google/gemini-3-flash-preview`
- Prompt/instruction: Same structured Khmer menu extraction prompt in `scripts/extract_menus.py`, rerun with `--max-tokens 800`.
- Input source: `data/crops_manifest.csv`.
- Output file/result: `data/intermediate/crop_validation_low_tokens.jsonl`.
- Manual corrections:
  - Used low token limit because OpenRouter rejected the prior crop run at `max_tokens=4000`.
  - Incorporated confirmations only where the cropped OCR output explicitly supported the final claim.
- Known limitations:
  - `crop_001`, `crop_002`, and `crop_003` returned `finish_reason=length`.
  - `crop_001` confirmed Chicken Rice at `8000៛`.
  - `crop_003` confirmed Anchor Beer at `3.000៛`.
  - `crop_004` confirmed restaurant name as `ឥន្ទធនូ (Rainbow)`.
  - `crop_002` did not provide a clean low-token confirmation of the roasted lotus root `12000៛` row before truncation.

## Entry Template

```text
### YYYY-MM-DD HH:MM - Short description

- Tool/model used:
- Prompt/instruction:
- Input source:
- Output file/result:
- Manual corrections:
- Known limitations:
```
