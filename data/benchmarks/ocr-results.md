# OCR Benchmark Results

## Dataset

- Local dataset observed: 10 PNG menu screenshots in `data/`.
- Expected project prompt: approximately 30 Cambodian restaurant menus.
- Manifest: `data/manifest.csv`.
- Raw extraction output: `data/intermediate/extractions_full.jsonl`.

## Models

| Model | Role | Result |
|---|---|---|
| `google/gemini-3-flash-preview` | Primary OCR/extraction model | Completed all 10 menus with `finish_reason=stop`. Best overall source for final recommendation. |
| `qwen/qwen3-vl-235b-a22b-instruct` | Challenger OCR/extraction model | Completed most menus, but returned `finish_reason=length` on dense pages `menu_006` and `menu_008`. Useful cross-check, less reliable for long menus under current token limit. |
| `openai/gpt-4o` | Targeted validation attempt | Did not run successfully. OpenRouter returned `402 Payment Required` because remaining credits could not cover the requested `max_tokens=4000`. |
| `anthropic/claude-sonnet-4-6` | Targeted validation attempt | Did not run successfully. OpenRouter returned `402 Payment Required` because remaining credits could not cover the requested `max_tokens=4000`. |
| `google/gemini-2.5-flash` | Targeted validation attempt | Did not run successfully. OpenRouter returned `402 Payment Required` because remaining credits could not cover the requested `max_tokens=4000`. |

## Run Notes

- Initial smoke test: `menu_001` through both models succeeded.
- Full run timed out once and was resumed with `--source-id`.
- Raw JSONL intentionally preserves duplicate and failed/interrupted records.
- Benchmark summaries should dedupe by `source_id + model` and prefer complete `finish_reason=stop` records.
- Total recorded API cost in raw outputs, including duplicate resume calls: about `$0.126`.
- A later targeted validation pass on `menu_005`, `menu_006`, and `menu_007` attempted GPT-4o, Claude Sonnet, and Gemini 2.5 Flash, but all nine calls failed with OpenRouter credit-limit errors. Raw error records are preserved in `data/intermediate/validation_models.jsonl`.

## Candidate Extraction Findings

- Best beer source: `menu_006`, where Gemini clearly extracted multiple beer options including Anchor, Tuborg, Angkor, Leo, Cambodia, Tiger, and Heineken.
- Best low-cost food source: `menu_005`, where Gemini extracted chicken rice and vegetable/snack items at low riel prices.
- Best named USD restaurant source: `menu_009` and `menu_010`, Reatry Battambong Restaurant, but no beer page was available from that restaurant in the provided screenshots.
- Qwen was helpful as a cross-check on some pages but missed target items on `menu_005` and truncated on the dense beer page.

## Model Comparison

Gemini was selected as the primary evidence source for the final recommendation because it:

- Completed all 10 menu screenshots.
- Extracted the relevant low-cost chicken, vegetable, and beer candidates.
- Preserved more price context on dense menu pages.
- Identified the visible Rainbow branding on the adjacent `menu_007` page.

Qwen was still useful because it:

- Often returned cleaner raw JSON without Markdown fences.
- Cross-checked several USD menu items from Reatry Battambong.
- Provided alternative interpretations for ambiguous Khmer rows.

## Benchmark Weaknesses

- No ground-truth labels were provided, so scoring is based on manual inspection and model agreement.
- Duplicate records from resumed runs are kept in raw output and must be filtered during analysis.
- Dense menus can exceed Qwen output length at the current `max_tokens=4000`.
- Some final item names still need a Khmer reader or targeted crop OCR for higher confidence.
- Additional validation models were attempted too late, after credits were nearly exhausted, so they did not provide usable evidence.
