# Debrief Notes

## What I Would Do Differently On A Second Attempt

- Start by building a manifest and logging scaffold immediately, before any extraction.
- Run a one-image benchmark first, then choose the primary model based on actual output shape.
- Use Gemini as the default model and Qwen as a targeted cross-check rather than running both on every page.
- Crop dense menu sections before OCR to reduce truncation and improve item-price alignment.
- Create a small manual verification table for only the final candidate rows.
- Ask early whether the expected approximately 30 menus are all present, since the local dataset contains 10 PNG screenshots.

## How I Would Scale This Up

At larger scale, I would separate the pipeline into stages: image inventory, OCR/extraction, structured parsing, confidence scoring, manual review queue, and recommendation generation. Each extracted row would keep source image, crop coordinates, raw OCR text, normalized text, price as seen, normalized price, currency, model name, and confidence. I would not trust a recommendation unless the item-price pair has provenance back to a specific source image region.

For production or a much larger benchmark, I would add ground-truth labeling for a representative sample of Khmer menus, evaluate models by item recall and price-pair accuracy, and use targeted human review for low-confidence rows. I would also build currency normalization, duplicate detection, restaurant/page grouping, and a retrieval layer so the final answer can cite exact source rows instead of relying on broad model summaries.
