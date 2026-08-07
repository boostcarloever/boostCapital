# What I Don't Trust

## Ranked Weak Points

1. Restaurant grouping for the main recommendation.
   - `menu_005` and `menu_006` do not visibly show the restaurant name in the screenshots.
   - I infer they belong to the Rainbow / ឥន្ទធនូ menu set because `menu_007` is adjacent in the screenshot sequence and has matching menu context.
   - Supporting crop: `data/crops/menu_007_rainbow_identity.png`.
   - Cropped Gemini OCR confirmed `crop_004` as `ឥន្ទធនូ (Rainbow)`, but this still verifies the adjacent page rather than the exact food and drink pages.
   - First thing to verify with more time: confirm whether `menu_005`, `menu_006`, and `menu_007` are pages from the same physical menu.

2. Khmer item-name OCR quality.
   - Both models often produced Khmer text that required interpretation.
   - English guesses were more useful than raw Khmer extraction for selecting candidates.
   - I trust price visibility more than exact Khmer transcription.

3. Vegetable classification for "Roasted lotus root."
   - Gemini classified this as a vegetable candidate at `12000៛`.
   - I visually verified the menu area and price column, but the item name itself still depends on model translation.
   - Supporting crop: `data/crops/menu_005_roasted_lotus_root.png`.
   - Low-token cropped OCR for `crop_002` truncated before a clean confirmation of the exact `12000៛` target row, so this remains the least certain item in the final recommendation.
   - First thing to verify: ask a Khmer reader or run targeted OCR/crop extraction on the item row.

4. Duplicate and partial extraction records.
   - The full run timed out once and was resumed.
   - `data/intermediate/extractions_full.jsonl` contains duplicate calls for `menu_008`, `menu_009`, and `menu_010`.
   - Some interrupted records contain errors and no `raw_response.choices`.
   - This does not invalidate the final recommendation, but benchmark summaries must dedupe by `source_id + model`.

5. Qwen truncation on larger/dense menus.
   - `qwen/qwen3-vl-235b-a22b-instruct` returned `finish_reason=length` for `menu_006` and `menu_008`.
   - Gemini was more complete for the beer page and is the primary source for the final recommendation.

6. Failed extra validation pass.
   - I attempted a targeted second-pass validation with GPT-4o, Claude Sonnet, and Gemini 2.5 Flash on `menu_005`, `menu_006`, and `menu_007`.
   - All nine calls failed with OpenRouter `402 Payment Required` errors because the remaining credits could not cover `max_tokens=4000`.
   - This means the final recommendation is supported by Gemini 3 Flash, Qwen3-VL, and manual inspection, but not by the additional validation models.

7. Currency conversion.
   - I used a rough assessment conversion of `4,000៛ = $1`.
   - The recommendation has enough budget margin that small exchange-rate differences would not change the conclusion.

## Revised Accuracy Estimate

Original prediction:

- Item names: 60-75%
- Prices: 80-90%
- Currency: 70-85%
- Category classification: 70-80% after manual verification
- End-to-end recommendation reliability: 65-75%

Revised estimate after extraction:

- Item names: 55-70%
- Prices: 80-90%
- Currency: 80-90%
- Category classification: 75-85% for obvious chicken/vegetable/beer candidates
- End-to-end recommendation reliability: 70-80%

Why this differs:

- Item-name accuracy is slightly lower than expected because raw Khmer OCR was noisy and some English guesses disagreed between models.
- Price and currency accuracy were at or above expectation because many prices were visually clear and used obvious `$` or `៛` notation.
- Recommendation reliability is slightly higher than predicted because the final selected items have a large budget margin and visually clear prices.

## What I Would Verify First

- Confirm the restaurant identity and page grouping for `menu_005`, `menu_006`, and `menu_007`.
- Crop and re-run OCR on the `menu_005` chicken rice and roasted lotus root rows.
- Crop and re-run OCR on the `menu_006` Anchor beer row and can/bottle price headers.
- Ask a Khmer reader to verify the selected item names and whether "roasted lotus root" is a fair vegetable recommendation.
- If credits were available, rerun GPT-4o or Claude on only cropped target rows with a much smaller token limit.
