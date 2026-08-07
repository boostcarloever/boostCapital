# VerifyIQ Khmer Menu Intelligence Assessment

This repo contains a time-boxed solution for the VerifyIQ AI Engineering Assessment: use Khmer Cambodian restaurant menu screenshots to answer:

```text
I have a budget of $10. I want chicken, some vegetables, and a couple of beers.
What should I order, and from where?
```

## Final Answer

Start with [outputs/recommendation.md](outputs/recommendation.md).

Current recommendation: order from the Rainbow / ឥន្ទធនូ menu set:

- Chicken rice: `8000៛`
- Roasted lotus root: `12000៛`
- Anchor beer x2: `3,000៛ + 3,000៛`
- Total: `26000៛`, about `$6.50` using `4,000៛ = $1`

## Deliverables

- Written plan and pre-run accuracy prediction: [outputs/plan.md](outputs/plan.md)
- Assumptions: [outputs/assumptions.md](outputs/assumptions.md)
- Recommendation with provenance: [outputs/recommendation.md](outputs/recommendation.md)
- Weaknesses and revised accuracy estimate: [outputs/what-i-dont-trust.md](outputs/what-i-dont-trust.md)
- Debrief notes: [outputs/debrief.md](outputs/debrief.md)
- AI usage trail: [logs/ai-usage.md](logs/ai-usage.md)
- Benchmark notes: [data/benchmarks/ocr-results.md](data/benchmarks/ocr-results.md)
- Presentation prep: [interview/README.md](interview/README.md)

## Data And Evidence

- Source manifest: [data/manifest.csv](data/manifest.csv)
- Crop manifest: [data/crops_manifest.csv](data/crops_manifest.csv)
- Raw extraction outputs: `data/intermediate/*.jsonl`
- Manual crop evidence: `data/crops/`
- Extraction script: [scripts/extract_menus.py](scripts/extract_menus.py)

## Run Commands

Install dependencies:

```bash
uv sync
```

Run full extraction:

```bash
uv run python scripts/extract_menus.py
```

Run low-token crop validation:

```bash
uv run python scripts/extract_menus.py --manifest data/crops_manifest.csv --output data/intermediate/crop_validation_low_tokens.jsonl --models google/gemini-3-flash-preview --limit 4 --max-tokens 800
```

`OPENROUTER_API_KEY` must be set in `.env`. Do not commit the real key.
