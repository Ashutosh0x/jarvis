# Jarvis Local AI Setup — Unlimited-OCR + Gemma Local Mode

Jarvis supports two local, fully private AI backends.

This document previously said Jarvis "falls back to cloud Gemini when they're
offline". **That is no longer true and this note exists because the stale
sentence was later read, reasonably, as evidence that screenshots were being
sent to Google.** Vision runs on local Gemma; the only fallback for screen
reading is the optional OCR server below, which also listens on loopback. When
neither is running, Jarvis says it cannot read the screen rather than sending it
anywhere.

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
| Typed: "read screen" command | auto | local Gemma vision; local parser as fallback |
| Downloads watcher (`download-added`) | auto | parses, then `ragService.ingest` — needs a parser up, either backend |

The anti-repetition logits processor (`ngram_size=35`, window 128/1024) is
applied per the model card.

---

## 1b. VisionPsy-Nano (CPU document parsing — no GPU required)

Unlimited-OCR above needs an NVIDIA card. Without one, document parsing is not
degraded, it is **absent** — and that costs more than it first appears. The
Downloads watcher already ingests parsed documents into the RAG corpus and says
*"I have read and memorized {name}. Ask me about it anytime."*, but it is gated
on a parser being reachable. On a CPU-only machine that sentence never plays and
nothing you read ever becomes durable memory.

[VisionPsy-Nano-460M](https://huggingface.co/qvac/VisionPsy-Nano-460M-GGUFs)
(Tether/QVAC, Apache 2.0) fills that gap on CPU. It is a SigLIP2 encoder over a
SmolLM2-360M backbone, and it beats Gemma 3 4B on document benchmarks at roughly
one-ninth the parameters:

| Benchmark | Gemma 3 4B-IT | VisionPsy-Nano-460M |
|---|---|---|
| DocVQA | 75.8 | **83.5** |
| TextVQA | 57.8 | **79.5** |
| ChartQA | 68.8 | **77.2** |
| OCRBench | — | 765 / 1000 |

**Use the standard variant, not Flash.** Flash is the mobile-latency build, and
its own model card states its largest quality gaps are in OCR and fine-grained
perception — exactly this job. Flash is for glance-and-answer.

### Install

```bash
# 1. llama.cpp (provides llama-server with vision support)
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp && cmake -B build && cmake --build build --config Release

# 2. Weights — Q4_K_M with imatrix is the recommended trade-off
#    (-0.24 points, -0.39% relative vs FP32)
hf download qvac/VisionPsy-Nano-460M-GGUFs \
    visionpsy-nano-460m-q4_k_m-imat.gguf mmproj-visionpsy-nano-460m-q8.gguf \
    --local-dir ./models/visionpsy
```

Then point Jarvis at them. The server is **not started unless both are set**:

```powershell
$env:JARVIS_VISION_MODEL  = "C:\path\to\models\visionpsy\visionpsy-nano-460m-q4_k_m-imat.gguf"
$env:JARVIS_VISION_MMPROJ = "C:\path\to\models\visionpsy\mmproj-visionpsy-nano-460m-q8.gguf"
$env:JARVIS_LLAMA_SERVER  = "C:\path\to\llama.cpp\build\bin\llama-server.exe"  # if not on PATH
```

### How it is chosen

`perform-ocr` picks a backend per request, not at boot — the GPU server is often
started by hand after Jarvis is already running.

| Unlimited-OCR | VisionPsy | Backend used |
|---|---|---|
| up | up | **Unlimited-OCR** (multi-page in one pass; never silently demoted) |
| up | down | Unlimited-OCR |
| down | up | **VisionPsy** |
| down | down | Error naming both, rather than a silent empty parse |

Pass `{ backend: 'visionpsy' }` to `performOCR` to pin it explicitly.

### Known limits

- **One image per query, by design.** Multi-page PDFs are looped page by page
  and stitched, not sent in one pass. A page that fails is marked inline as
  `<!-- page N: not parsed -->` rather than dropped — a silently missing page
  becomes a confident wrong answer once it is in the corpus.
- **English only.**
- Hallucinates or miscounts on dense documents; the page prompt instructs it to
  omit unreadable regions rather than guess.
- Not used for `handleReadScreen`. Gemma keeps that path: its 896×896 encoder
  with Pan & Scan tiling (+8.2 DocVQA on the 4B) handles dense 1080p screens,
  which a single downscaled pass does not.

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
curl http://127.0.0.1:10000/health      # Unlimited-OCR server (GPU)
curl http://127.0.0.1:8772/health       # VisionPsy server (CPU)
curl http://localhost:11434/api/tags    # Ollama
```

Jarvis probes all three automatically. `checkOcrServer` reports whether *any*
parser is reachable plus which one answered:

```js
await window.electronAPI.checkOcrServer();
// { available: true, backend: 'visionpsy', url: 'http://127.0.0.1:8772',
//   backends: { unlimitedOcr: false, visionPsy: true } }
```

`checkVisionServer` probes the CPU backend alone; `checkOllama` covers Gemma.
