# Jarvis Local AI Setup — Unlimited-OCR + Gemma Local Mode

Jarvis supports two local, fully private AI backends. Both are optional — Jarvis
falls back to cloud Gemini when they're offline.

---

## 1. Unlimited-OCR (document & screen parsing)

[Baidu Unlimited-OCR](https://github.com/baidu/Unlimited-OCR) is a 3B-MoE
(500M active) vision model that parses images and **multi-page PDFs in one
pass** into structured Markdown, using constant-memory R-SWA attention
(paper: [arXiv:2606.23050](https://arxiv.org/abs/2606.23050)).

**Requirements:** NVIDIA GPU (~6–8GB VRAM), CUDA, Python 3.12.

### Install & launch the SGLang server

```bash
# 1. Create environment (uv recommended)
uv venv jarvis-ocr --python 3.12
# Windows:
jarvis-ocr\Scripts\activate

# 2. Install SGLang + deps (per model card: torch 2.10, transformers 4.57.1)
uv pip install "sglang[all]" pymupdf

# 3. Launch (Jarvis expects port 10000)
python -m sglang.launch_server \
    --model baidu/Unlimited-OCR \
    --served-model-name Unlimited-OCR \
    --attention-backend fa3 \
    --page-size 1 \
    --mem-fraction-static 0.8 \
    --context-length 32768 \
    --enable-custom-logit-processor \
    --disable-overlap-schedule \
    --skip-server-warmup \
    --host 0.0.0.0 \
    --port 10000
```

Override the URL with the `JARVIS_OCR_URL` environment variable if you run it
elsewhere.

### How Jarvis uses it

| Trigger | Mode | Notes |
|---|---|---|
| Voice: "read my screen" / `ocr_screen` tool | `gundam` (dynamic res) | dense single-page layouts |
| Voice: "parse ~/Downloads/x.pdf" / `parse_document_ocr` tool | `base` (1024×1024) | multi-page, up to 20 pages/pass |
| Typed: "read screen" command | auto | local OCR if server is up, else Gemini Vision |

The anti-repetition logits processor (`ngram_size=35`, window 128/1024) is
applied per the model card.

---

## 2. Gemma Local Mode (private LLM via Ollama)

1. Install [Ollama](https://ollama.com) and pull a Gemma model:
   ```bash
   ollama pull gemma3:4b     # light, fits most machines
   ollama pull gemma4:12b    # stronger; needs ~16GB RAM
   ```
2. In Jarvis settings (localStorage `jarvis_settings`), set:
   ```json
   { "llmProvider": "gemma-local", "localModel": "gemma3:4b" }
   ```
3. Typed/spoken AI commands now stream from local Gemma instead of Gemini
   Live. Responses are spoken via the system TTS voice.

**Roadmap (not yet wired):** full offline voice loop with faster-whisper STT
and [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) TTS
(OpenAI-compatible streaming endpoints at `localhost:8880`).

---

## 3. Quick health checks

```bash
curl http://127.0.0.1:10000/health      # Unlimited-OCR server
curl http://localhost:11434/api/tags    # Ollama
```

Jarvis probes both automatically (`checkOcrServer` IPC / `checkOllama`).
