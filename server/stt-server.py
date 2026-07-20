# Jarvis Local STT Server
# Streaming speech-to-text over WebSocket using faster-whisper (CTranslate2).
# Fully offline after the first model download.
#
# Protocol (ws://127.0.0.1:8770):
#   - binary frames: 16 kHz mono PCM16 audio chunks (append to utterance buffer)
#   - text frame '{"type":"end"}': utterance finished -> transcribe -> reply
#       {"type":"final", "text": "...", "ms": <transcribe_ms>}
#   - text frame '{"type":"reset"}': drop the current buffer
#
# The client (Jarvis renderer) does voice-activity detection and sends one
# utterance at a time, which keeps this server simple and fast. On a CPU,
# the base model transcribes a short command in well under a second.
#
# Run (dependencies resolved automatically by uv). The -I (isolated) flag is
# REQUIRED on this machine: a polluted Roaming\Python312 user-site otherwise
# leaks mismatched native wheels into the env and crashes numpy/ctranslate2
# with 0xC0000005 on import.
#   uv run --python 3.12 --with faster-whisper --with websockets python -I server/stt-server.py

import asyncio
import json
import logging
import os
import time

import numpy as np
import websockets
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("jarvis-stt")

MODEL_NAME = os.environ.get("JARVIS_STT_MODEL", "base")
PORT = int(os.environ.get("JARVIS_STT_PORT", "8770"))

log.info(f"Loading faster-whisper model '{MODEL_NAME}' (first run downloads it)...")
model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
log.info("Model ready.")


async def handle(ws):
    buffer = bytearray()
    log.info("Client connected")
    try:
        async for message in ws:
            if isinstance(message, (bytes, bytearray)):
                buffer.extend(message)
                # Safety cap: 60 s of 16 kHz PCM16
                if len(buffer) > 16000 * 2 * 60:
                    del buffer[: len(buffer) - 16000 * 2 * 60]
                continue

            try:
                msg = json.loads(message)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "reset":
                buffer.clear()

            elif msg.get("type") == "end":
                if len(buffer) < 16000 * 2 // 4:  # ignore blips under 250 ms
                    buffer.clear()
                    continue
                t0 = time.time()
                audio = np.frombuffer(bytes(buffer), dtype=np.int16).astype(np.float32) / 32768.0
                buffer.clear()
                segments, _info = model.transcribe(
                    audio,
                    language="en",
                    beam_size=1,          # greedy: fastest, fine for commands
                    vad_filter=True,      # trim leading/trailing silence
                    condition_on_previous_text=False,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
                ms = int((time.time() - t0) * 1000)
                log.info(f"[{ms} ms] {text!r}")
                await ws.send(json.dumps({"type": "final", "text": text, "ms": ms}))
    except websockets.ConnectionClosed:
        pass
    finally:
        log.info("Client disconnected")


async def main():
    async with websockets.serve(handle, "127.0.0.1", PORT, max_size=16 * 1024 * 1024):
        log.info(f"Jarvis STT listening on ws://127.0.0.1:{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
