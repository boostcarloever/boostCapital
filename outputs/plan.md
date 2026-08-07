# Written Plan

## 15-Minute Checkpoint Plan

I will treat this as a time-boxed OCR, extraction, and verification problem where provenance matters more than full menu coverage. First, I will inventory the provided PNG menus and assign each image a stable source ID. Then I will run a model-assisted extraction pass over the menu images, targeting structured rows with the original Khmer item text, possible English meaning, price exactly as shown, inferred currency, source filename, and confidence. I will optimize for the user query rather than complete menu reconstruction: chicken dishes, vegetable dishes, and beer.

The first OCR/extraction model will be `google/gemini-3-flash-preview` because it is expected to be fast, cheap, and strong at general OCR. I will test it against `qwen/qwen3-vl-235b-a22b-instruct` as a challenger model for multilingual/vision extraction, especially because Khmer may benefit from a model trained strongly on Asian scripts. If either model is unavailable through OpenRouter or performs poorly, I will fall back to targeted manual verification: inspect the PNGs directly, ask the model narrow questions only for visible candidate regions, and recommend only items whose source menu and price I can cite.

Given the 3-hour limit, I am explicitly not building a polished UI, a complete OCR benchmark suite, a production database, perfect Khmer translation, exhaustive restaurant ranking, or complete extraction of every menu item. A partial recommendation with traceable evidence, clear uncertainty, and defensible reasoning is better than a broader recommendation that cannot be audited.

## Pre-Processing Accuracy Prediction

Before processing menu content, my expected extraction accuracy is:

- Item names: 60-75%
- Prices: 80-90% when clearly printed and aligned near the item
- Currency: 70-85%
- Category classification for chicken, vegetables, and beer: 70-80% after manual verification
- End-to-end recommendation reliability: 65-75%, because the final answer depends on both OCR quality and correct item-price pairing

Expected failure modes:

- Khmer OCR mistakes from stylized fonts, scans, compression, or image cropping
- Price-item mismatches when menus use columns or dense layouts
- Confusion between USD and Cambodian riel notation
- Misclassification of dish ingredients when the Khmer name is ambiguous
- Beer count or size ambiguity
- Missing data if the local dataset has fewer than the expected approximately 30 menus
