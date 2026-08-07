# Assumptions

- The files in `data/` are the dataset provided for this assessment run.
- The assessment text says approximately 30 menus, but the local dataset currently appears to contain 10 PNG screenshots. I will treat the local files as the available dataset unless more files are added.
- The budget of `$10` means 10 US dollars.
- "A couple of beers" means 2 beers.
- "Some vegetables" can be satisfied by one vegetable dish, side dish, or mixed dish whose visible/extracted name clearly indicates vegetables.
- Chicken can be satisfied by a dish whose visible/extracted name clearly indicates chicken.
- If prices are shown in Cambodian riel, I will preserve the original observed price and separately state the USD conversion assumption.
- If prices are shown in mixed currencies, I will keep the original currency per item and normalize only for totaling.
- A single-restaurant recommendation is preferred when it can satisfy chicken, vegetables, and two beers within budget.
- A multi-restaurant recommendation is acceptable if no single restaurant candidate can be verified within budget.
- Model-assisted OCR and translation may be wrong; final recommended items require manual or model-cross-checked provenance.
- Hand verification is acceptable only when explicitly labeled.
- OpenRouter prompts, model names, outputs, and manual corrections must be logged as assessment evidence.
- Raw model outputs should be preserved separately from cleaned or normalized extraction results.
- The final answer should include a ranked "what I don't trust" section even if the recommendation appears plausible.
