from __future__ import annotations

import argparse
import base64
import csv
import json
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv


DEFAULT_MODELS = [
    "google/gemini-3-flash-preview",
    "qwen/qwen3-vl-235b-a22b-instruct",
]

PROMPT = """You are extracting Khmer restaurant menu information for an audit-heavy assessment.

Return ONLY valid JSON with this schema:
{
  "restaurant_name": string | null,
  "menu_language": string | null,
  "currency_notes": string | null,
  "items": [
    {
      "khmer_text": string,
      "english_guess": string | null,
      "price_as_seen": string | null,
      "currency_guess": string | null,
      "category_tags": string[],
      "is_chicken_candidate": boolean,
      "is_vegetable_candidate": boolean,
      "is_beer_candidate": boolean,
      "confidence": number,
      "notes": string | null
    }
  ],
  "image_quality_notes": string | null,
  "uncertain_price_or_alignment_notes": string[]
}

Extraction rules:
- Preserve Khmer item text exactly as visible when possible.
- Preserve prices exactly as visible. Do not silently convert or clean prices.
- Include likely chicken, vegetable, and beer items even if uncertain.
- Include enough non-target nearby rows to help audit price alignment.
- Mark uncertain or inferred information clearly in notes.
- If the image is not a menu or text is unreadable, return an empty items list with notes.
"""


def image_to_data_url(path: Path) -> str:
    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def read_manifest(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as file:
        return list(csv.DictReader(file))


def call_openrouter(
    model: str, image_path: Path, api_key: str, max_tokens: int
) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": image_to_data_url(image_path)},
                    },
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=120,
    )
    response.raise_for_status()
    return response.json()


def extract_text(response_json: dict[str, Any]) -> str:
    try:
        content = response_json["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text", "")))
        return "\n".join(parts)

    return str(content)


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(record, ensure_ascii=False) + "\n")


def run(args: argparse.Namespace) -> None:
    load_dotenv()
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is missing. Add it to .env before running.")

    manifest = read_manifest(args.manifest)
    models = args.models or DEFAULT_MODELS
    rows = manifest
    if args.source_id:
        wanted = set(args.source_id)
        rows = [row for row in rows if row.get("source_id") in wanted]
    if args.limit:
        rows = rows[: args.limit]

    for row in rows:
        image_path = Path(row["relative_path"])
        if not image_path.exists():
            append_jsonl(
                args.output,
                {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "source_id": row.get("source_id"),
                    "image_path": str(image_path),
                    "error": "image file not found",
                },
            )
            continue

        for model in models:
            started_at = datetime.now(timezone.utc).isoformat()
            record: dict[str, Any] = {
                "timestamp": started_at,
                "source_id": row.get("source_id"),
                "image_path": str(image_path),
                "model": model,
                "prompt": PROMPT,
            }
            try:
                response_json = call_openrouter(
                    model, image_path, api_key, args.max_tokens
                )
                record["raw_response"] = response_json
                record["model_text"] = extract_text(response_json)
            except requests.RequestException as exc:
                record["error"] = f"{type(exc).__name__}: {exc}"
                if getattr(exc, "response", None) is not None:
                    record["response_text"] = exc.response.text

            append_jsonl(args.output, record)
            print(f"{row.get('source_id')} {model} -> {args.output}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract Khmer menu items from PNG menus.")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("data/manifest.csv"),
        help="CSV with source_id and relative_path columns.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/intermediate/extractions.jsonl"),
        help="JSONL file for raw extraction records.",
    )
    parser.add_argument(
        "--models",
        nargs="*",
        default=None,
        help="OpenRouter model ids. Defaults to Gemini 3 Flash and Qwen3-VL.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional number of manifest rows to process for smoke tests.",
    )
    parser.add_argument(
        "--source-id",
        nargs="*",
        default=None,
        help="Optional source_id values to process, such as menu_009 menu_010.",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=4000,
        help="Maximum completion tokens to request from OpenRouter.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    run(parse_args())
