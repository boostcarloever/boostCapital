# Benchmarks

This folder stores the raw benchmark evidence for the assessment.

## Models Under Test

- Primary OCR/extraction model: `google/gemini-3-flash-preview`
- Challenger OCR/extraction model: `qwen/qwen3-vl-235b-a22b-instruct`

## Initial Benchmark Plan

1. Run both models on the same menu image subset.
2. Compare whether each model extracts:
   - restaurant/menu identity when visible
   - Khmer item text
   - price as seen
   - currency or price notation
   - chicken candidates
   - vegetable candidates
   - beer candidates
3. Manually inspect high-value candidates and record whether the item-price pairing appears trustworthy.

## Smoke-Test Command

Run one image through both default models:

```bash
uv run python scripts/extract_menus.py --limit 1
```

Run all manifest images through both default models:

```bash
uv run python scripts/extract_menus.py
```

## Raw Outputs

Default output path:

```text
data/intermediate/extractions.jsonl
```

Preserve raw model responses. Do not overwrite or clean them without saving the original output.

## Scoring Notes Template

```text
source_id:
model:
item_name_accuracy_notes:
price_accuracy_notes:
currency_accuracy_notes:
target_item_findings:
manual_verification_result:
known_failure_modes:
```
