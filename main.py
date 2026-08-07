from dotenv import load_dotenv
import os
import requests

load_dotenv()
api_key = os.getenv("OPENROUTER_API_KEY")

if not api_key:
    raise ValueError("OPENROUTER_API_KEY not found — check your .env file")

response = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    },
    json={
        "model": "openai/gpt-4o",
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 2000
    }
)

print(response.json())