# Jarvis Local TTS Server
# Streaming text-to-speech over WebSocket using Microsoft Edge Neural Voices.
# Uses edge-tts (free, no API key, Azure-quality neural voices).
#
# Protocol (ws://127.0.0.1:8771):
#   Client sends JSON text frames:
#     {"type":"speak", "id":N, "text":"...", "voice":"en-US-GuyNeural", "speed":1.0}
#     {"type":"interrupt", "id":N}
#     {"type":"voices"}
#
#   Server sends:
#     JSON text frames: {"type":"begin", "id":N}   <- audio below belongs to N
#     Binary frames: MP3 audio chunks (client decodes with WebAudio)
#     JSON text frames: {"type":"done", "id":N, "ms":..., "bytes":...}
#                       {"type":"voices", "voices":[...]}
#                       {"type":"interrupted", "id":N}
#
# The id exists because cancellation is not instantaneous: chunks already
# queued on the socket arrive after the interrupt, and the client needs to
# know they belong to a sentence the user cut off.
#
# Run:
#   uv run --python 3.12 --with edge-tts --with websockets python -I server/tts-server.py

import asyncio
import json
import logging
import os
import time

import edge_tts
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("jarvis-tts")

PORT = int(os.environ.get("JARVIS_TTS_PORT", "8771"))
DEFAULT_VOICE = os.environ.get("JARVIS_TTS_VOICE", "en-US-GuyNeural")
DEFAULT_SPEED = float(os.environ.get("JARVIS_TTS_SPEED", "1.0"))

async def handle(ws):
    log.info("Client connected")

    # Per-connection, not global: a second client must never be able to cancel
    # the first one's speech.
    #
    # Synthesis runs as its own task rather than inline in this loop. Awaiting
    # it here instead — the obvious shape, and what this did before — means the
    # loop is not reading the socket while Jarvis talks, so the interrupt frame
    # sits unread in the receive buffer until synthesis has finished on its
    # own. Barge-in was structurally impossible: the cancel could only ever
    # arrive after the thing it was cancelling had ended.
    current_task = None

    try:
        async for message in ws:
            if not isinstance(message, str):
                continue

            try:
                msg = json.loads(message)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "interrupt":
                if current_task and not current_task.done():
                    current_task.cancel()
                    log.info("Synthesis interrupted")

            elif msg_type == "voices":
                try:
                    voices = await edge_tts.list_voices()
                    en_voices = [
                        {"name": v["ShortName"], "gender": v["Gender"]}
                        for v in voices if v["Locale"].startswith("en-")
                    ]
                    await ws.send(json.dumps({"type": "voices", "voices": en_voices}))
                except Exception as e:
                    log.error(f"Voice listing failed: {e}")
                    await ws.send(json.dumps({"type": "voices", "voices": []}))

            elif msg_type == "speak":
                text = msg.get("text", "").strip()
                if not text:
                    continue

                voice = msg.get("voice", DEFAULT_VOICE)
                speed = msg.get("speed", DEFAULT_SPEED)
                utt_id = msg.get("id")

                # Cancel any in-progress synthesis and wait for it to actually
                # stop, so two utterances can never interleave on the socket.
                if current_task and not current_task.done():
                    current_task.cancel()
                    await asyncio.gather(current_task, return_exceptions=True)

                current_task = asyncio.create_task(
                    run_synthesis(ws, text, voice, speed, utt_id)
                )

    except websockets.ConnectionClosed:
        pass
    finally:
        if current_task and not current_task.done():
            current_task.cancel()
            await asyncio.gather(current_task, return_exceptions=True)
        log.info("Client disconnected")


async def run_synthesis(ws, text, voice, speed, utt_id):
    """One utterance, cancellable. Reports its own outcome to the client."""
    try:
        await synthesize_and_stream(ws, text, voice, speed, utt_id)
    except asyncio.CancelledError:
        log.info("Synthesis cancelled")
        try:
            await ws.send(json.dumps({"type": "interrupted", "id": utt_id}))
        except Exception:
            pass
        raise
    except websockets.ConnectionClosed:
        pass
    except Exception as e:
        # edge-tts reaches out to Microsoft's endpoint; DNS failures and 4xx
        # responses are routine offline. Tell the client so it falls back to
        # SAPI instead of waiting for a 'done' that is never coming.
        log.error(f"Synthesis failed: {e}")
        try:
            await ws.send(json.dumps({"type": "error", "id": utt_id, "message": str(e)}))
        except Exception:
            pass


async def synthesize_and_stream(ws, text, voice, speed, utt_id=None):
    """Synthesize text and stream MP3 chunks back to the client."""
    t0 = time.time()

    # Convert speed multiplier to edge-tts rate string
    # edge-tts uses "+50%" or "-20%" format
    rate_pct = int((speed - 1.0) * 100)
    rate_str = f"+{rate_pct}%" if rate_pct >= 0 else f"{rate_pct}%"

    communicate = edge_tts.Communicate(text, voice, rate=rate_str)

    # Claim the stream before any audio: everything the client receives from
    # here until the next 'begin' belongs to this utterance.
    await ws.send(json.dumps({"type": "begin", "id": utt_id}))

    total_bytes = 0
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            data = chunk["data"]
            if data:
                await ws.send(data)
                total_bytes += len(data)

    ms = int((time.time() - t0) * 1000)
    log.info(f"[{ms} ms] streamed {total_bytes} bytes for: {text[:60]!r}")
    await ws.send(json.dumps({
        "type": "done",
        "id": utt_id,
        "ms": ms,
        "bytes": total_bytes,
    }))


async def main():
    async with websockets.serve(handle, "127.0.0.1", PORT, max_size=4 * 1024 * 1024):
        log.info(f"Jarvis TTS listening on ws://127.0.0.1:{PORT}")
        log.info(f"Default voice: {DEFAULT_VOICE}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
