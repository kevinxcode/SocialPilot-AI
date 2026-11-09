# Setting up AI providers

Go to **Dashboard → AI Providers**. Keys are stored only in this browser (`chrome.storage.local`). They are never exported and never logged. They are not encrypted, so anyone with access to this Chrome profile can read them.

## Ollama (local, free)

1. Install Ollama, then run `ollama pull qwen3:8b` (or another chat model; a vision model such as `qwen3-vl:8b` handles images).
2. Host: `http://localhost:11434` (the default). For another machine, enter its URL. Chrome will ask for permission to access that host.
3. Click **Test connection** and pick a default model.

Two things are handled for you:

- **The extension origin.** Ollama normally rejects `chrome-extension://` origins with a 403. The extension removes the `Origin` header, but only on its own requests to the configured Ollama host. It does this with a `declarativeNetRequest` rule, so you do not need to set `OLLAMA_ORIGINS`.
- **Reasoning models.** Models such as qwen3 are called with `think: false`, so the answer isn't spent on hidden reasoning. Embedding-only models such as `bge-m3` are hidden from the model list.

Ollama is shown as costing **Rp0**. That figure doesn't include your hardware or electricity.

## OpenRouter

Paste your key (`sk-or-…`), then refresh the models. Models marked **Free** have a price of 0. Free models are often rate-limited upstream (HTTP 429); in Auto mode the router then falls back to the next provider.

## NVIDIA API Catalog

Paste your key (`nvapi-…`). NVIDIA works on credits, so its models are always treated as **paid**.

## Router modes

| Mode | Behaviour |
|---|---|
| Auto | Tries the providers in priority order (default: Ollama → NVIDIA → OpenRouter) and falls back on failure |
| Manual | Uses only the selected provider, with no fallback |
| Free-Only | Uses only Ollama and free models; paid models are never called |
| Offline | Uses only Ollama |

Paid models are used only when **Allow paid models** is on, and only until the **daily cap** is reached. A model with no known price is treated as paid. Autopilot has its own model choice, its own *allow paid* switch and its own cap.
