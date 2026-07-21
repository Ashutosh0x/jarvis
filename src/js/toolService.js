import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import perf from "./services/perf.js";

// Initialize standard client for tool execution
let genAI = null;
const getClient = () => {
    if (!genAI) {
        const apiKey = config.geminiApiKey;
        genAI = new GoogleGenAI({ apiKey });
    }
    return genAI;
};

/* =========================
   LOCAL MODE — Gemma via Ollama
   100% private inference against the local Ollama server.
   Uses Ollama's native /api/chat NDJSON streaming endpoint.
========================= */

function getLocalConfig() {
    try {
        const stored = JSON.parse(localStorage.getItem('jarvis_settings') || '{}');
        return {
            url: stored.localOllamaUrl || 'http://localhost:11434',
            model: stored.localModel || 'gemma3:4b',
        };
    } catch {
        return { url: 'http://localhost:11434', model: 'gemma3:4b' };
    }
}

// Quick health probe so the UI can show whether Local Mode is available
export async function checkOllama() {
    const { url } = getLocalConfig();
    try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return { available: false };
        const data = await res.json();
        return {
            available: true,
            models: (data.models || []).map(m => m.name),
        };
    } catch {
        return { available: false };
    }
}

/**
 * Stream a chat completion from local Gemma.
 * @param {Array<{role: string, content: string}>} messages
 * @param {(chunk: string) => void} onChunk - called per streamed token/segment
 * @returns {Promise<string>} the full response text
 */
/**
 * Local VISION: describe/read a screenshot with Gemma 3 (a multimodal model)
 * through Ollama. Fully offline — no OCR server, no cloud. `imageInput` may be
 * a data URL or raw base64; the data-URL prefix is stripped for Ollama.
 * @returns {Promise<string>} the model's description/answer
 */
export async function describeImageLocal(imageInput, question) {
    const { url, model } = getLocalConfig();
    const base64 = String(imageInput).replace(/^data:image\/\w+;base64,/, '');
    const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            stream: false,
            keep_alive: '60m',
            messages: [{
                role: 'user',
                content: question || 'Describe what is on this screen concisely and accurately.',
                images: [base64],
            }],
        }),
    });
    if (!res.ok) {
        throw new Error(`Ollama vision error ${res.status}: is '${model}' a vision model? gemma3 supports images.`);
    }
    const data = await res.json();
    return (data.message?.content || '').trim();
}

/* Deadlines. Ollama had NO timeout here, and the interaction log for
   21 Jul 2026 shows what that costs: 11 local turns over 30s, four over 120s,
   worst 125.3s — against a 6.1s median. The machine was at 97% memory, so the
   model was being evicted and reloaded (or failing outright) while the user
   kept talking into a dead assistant.

   Bounding total generation time would truncate legitimately long answers, so
   the two deadlines that matter are bounded instead: time to the FIRST token
   (nothing is happening yet) and the gap BETWEEN tokens (it stalled). Once
   tokens flow, streaming TTS is already speaking and the wall-clock is hidden. */
export const FIRST_TOKEN_TIMEOUT_MS = 25000;
export const STALL_TIMEOUT_MS = 15000;

/** Error marker so callers can distinguish a timeout from a real Ollama fault. */
export class LocalTimeoutError extends Error {
    constructor(phase, ms) {
        super(phase === 'first-token'
            ? `local model produced nothing in ${Math.round(ms / 1000)}s`
            : `local model stalled for ${Math.round(ms / 1000)}s mid-answer`);
        this.name = 'LocalTimeoutError';
        this.phase = phase;
    }
}

export async function generateContentLocal(messages, onChunk, opts = {}) {
    const { url, model } = getLocalConfig();
    // Time to FIRST token is the number that matters for perceived speed: the
    // streaming TTS path starts speaking on the first completed sentence, so
    // total generation time is largely hidden behind Jarvis already talking.
    const _t0 = Date.now();
    let _firstTokenAt = null;

    // One controller for both the caller's cancellation (a new turn superseding
    // this one) and our own deadlines.
    const ctrl = new AbortController();
    let timedOut = null;
    let timer = null;
    const arm = (phase, ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = new LocalTimeoutError(phase, ms); ctrl.abort(); }, ms);
    };
    const onExternalAbort = () => ctrl.abort();
    if (opts.signal) {
        if (opts.signal.aborted) throw new DOMException('superseded', 'AbortError');
        opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onExternalAbort);
    };

    arm('first-token', FIRST_TOKEN_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(`${url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages,
                stream: true,
                keep_alive: '60m', // keep Gemma in RAM — no cold-load pause mid-conversation
            }),
            signal: ctrl.signal,
        });
    } catch (e) {
        cleanup();
        if (timedOut) throw timedOut;
        throw e;
    }

    if (!response.ok) {
        cleanup();
        throw new Error(`Ollama error ${response.status}: is '${model}' pulled? Try: ollama pull ${model}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Ollama streams NDJSON — one JSON object per line. A network chunk
            // can split a line, so only parse complete lines and keep the tail.
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    const piece = data.message?.content;
                    if (piece) {
                        if (_firstTokenAt === null) {
                            _firstTokenAt = Date.now();
                            perf.stage('llm.firstToken', _firstTokenAt - _t0);
                        }
                        // Progress: restart the clock on the stall deadline.
                        arm('stall', STALL_TIMEOUT_MS);
                        fullText += piece;
                        if (onChunk) onChunk(piece);
                    }
                } catch (e) {
                    console.warn('Ollama stream: skipping malformed line', line.slice(0, 80));
                }
            }
        }
    } catch (e) {
        // A timeout mid-answer keeps whatever was already spoken: partial truth
        // beats discarding a good half-answer and apologising.
        if (timedOut && fullText.trim()) {
            cleanup();
            perf.stage('llm.total', Date.now() - _t0);
            return fullText;
        }
        cleanup();
        throw timedOut || e;
    }

    cleanup();
    perf.stage('llm.total', Date.now() - _t0);
    return fullText;
}

/**
 * Local action router: Gemma classifies a spoken request into an executable
 * action. This is what makes Jarvis OBEY natural phrasing instead of only
 * exact regex matches. Uses Ollama's JSON mode for reliable structure.
 * Returns { action, arg } — action 'none' means "just answer conversationally".
 */
export async function routeLocalAction(query) {
    const { url, model } = getLocalConfig();
    try {
        const res = await fetch(`${url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                stream: false,
                format: 'json',
                keep_alive: '60m',
                options: { temperature: 0 },
                messages: [
                    {
                        role: 'system',
                        content: 'You route a voice command to an action. Reply ONLY with JSON: {"action": string, "arg": string}. Actions: "open_app" (arg: chrome|notepad|explorer|vscode|calculator|paint|downloads), "open_website" (arg: domain like youtube.com), "web_search" (arg: search query), "remember" (arg: the fact to store), "recall" (arg: what to look up in memory), "none" (anything else - questions, chat, requests you cannot map). When unsure, use "none".'
                    },
                    { role: 'user', content: query }
                ]
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) return { action: 'none' };
        const data = await res.json();
        const parsed = JSON.parse(data.message?.content || '{}');
        const action = ['open_app', 'open_website', 'web_search', 'remember', 'recall'].includes(parsed.action)
            ? parsed.action : 'none';
        return { action, arg: String(parsed.arg || '').slice(0, 300) };
    } catch (e) {
        console.warn('Action router failed (falling back to chat):', e.message);
        return { action: 'none' };
    }
}

// Distill DURABLE, STRUCTURED facts from recent interactions for the belief
// store. Two ideas combined:
//   - SelfMem: keep only stable, high-signal facts; reject volatile detail
//     (one-off prices/dates/weather), which stays recoverable from the raw log.
//   - BeliefMem: emit each fact as an ATTRIBUTE + VALUE with an evidence
//     strength (prob), so competing values of the same attribute ("browser =
//     Chrome" vs "browser = Firefox") can be reconciled rather than both stored.
// JSON-mode keeps the output parseable.
export async function distillFacts(interactionsText) {
    const { url, model } = getLocalConfig();
    try {
        const res = await fetch(`${url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                stream: false,
                format: 'json',
                keep_alive: '60m',
                options: { temperature: 0 },
                messages: [
                    {
                        role: 'system',
                        content:
                            'You consolidate an assistant\'s interaction log into long-term memory. ' +
                            'Reply ONLY with JSON: {"facts": [{"attribute": string, "value": string, "statement": string, "prob": number}]}. ' +
                            'Extract only DURABLE, reusable facts about the user or their world: stable preferences, ' +
                            'identity, tools they use, recurring people/places/projects, and habits. ' +
                            'For each fact: "attribute" is the short slot it describes (e.g. "preferred browser", "profession", "phone model"); ' +
                            '"value" is the specific value ("Chrome", "software engineer", "Redmi Note 10 Pro"); ' +
                            '"statement" is a short third-person sentence about "the user"; ' +
                            '"prob" is your confidence 0-1 that this is genuinely true and durable. ' +
                            'REJECT anything volatile or one-off: specific prices, dates, weather, single search queries, ' +
                            'transient status, or the assistant\'s own replies. If nothing durable is present, return {"facts": []}. ' +
                            'Return at most 8 facts, deduplicated by attribute.'
                    },
                    { role: 'user', content: String(interactionsText).slice(0, 8000) }
                ]
            }),
            signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) return { facts: [] };
        const data = await res.json();
        const parsed = JSON.parse(data.message?.content || '{}');
        const raw = Array.isArray(parsed.facts) ? parsed.facts : [];
        // Normalize + guard. Accept either the structured object or (for
        // robustness) a bare string, coercing the latter into the schema.
        const facts = raw.map((f) => {
            if (typeof f === 'string') {
                const s = f.trim();
                return s ? { attribute: s, value: s, statement: s, prob: 0.6 } : null;
            }
            const statement = String(f?.statement || f?.value || '').trim();
            const value = String(f?.value || f?.statement || '').trim();
            const attribute = String(f?.attribute || statement).trim();
            const prob = (typeof f?.prob === 'number' && f.prob >= 0 && f.prob <= 1) ? f.prob : 0.6;
            if (statement.length < 6 || statement.length > 200 || !value) return null;
            return { attribute, value, statement, prob };
        }).filter(Boolean).slice(0, 8);
        return { facts };
    } catch (e) {
        console.warn('Fact distillation failed:', e.message);
        return { facts: [] };
    }
}

export async function performSearch(query) {
    try {
        const ai = getClient();
        const result = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [{ role: 'user', parts: [{ text: query }] }],
            tools: [{ googleSearchRetrieval: {} }],
        });

        const text = result.text || "I found some information.";

        // Extract grounding chunks/sources if available
        // Note: SDK structure might return result.text directly or candidate content
        let finalSources = [];
        if (result.candidates && result.candidates[0]?.groundingMetadata) {
            finalSources = (result.candidates[0].groundingMetadata.groundingChunks || [])
                .map(chunk => chunk.web)
                .filter(web => web && web.uri && web.title)
                .map(web => ({
                    title: web.title,
                    uri: web.uri,
                }));
        }

        return { text, sources: finalSources };
    } catch (error) {
        console.error("Search error:", error);
        return { text: "I'm sorry, I encountered an error while searching.", sources: [] };
    }
}

export async function generateImage(prompt) {
    console.log("Generating image with prompt:", prompt);
    try {
        const ai = getClient();
        const result = await ai.models.generateContent({
            model: "gemini-3-pro-image-preview",
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });

        const parts = result.candidates[0].content.parts;
        for (const part of parts) {
            if (part.inlineData) {
                console.log("Image generation successful");
                return { imageUrl: `data:image/png;base64,${part.inlineData.data}` };
            }
        }
        return { imageUrl: null, error: "No image data received." };
    } catch (error) {
        console.error("Image generation error:", error);
        return { imageUrl: null, error: "Failed to generate image." };
    }
}

export async function reimagineImage(base64Image, prompt) {
    console.log("Reimagining image with prompt:", prompt);
    try {
        const ai = getClient();
        const result = await ai.models.generateContent({
            model: "gemini-3-pro-image-preview",
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType: "image/jpeg",
                                data: base64Image
                            }
                        },
                        { text: prompt }
                    ]
                }
            ]
        });

        const parts = result.candidates[0].content.parts;
        for (const part of parts) {
            if (part.inlineData) {
                console.log("Reimagine successful");
                return { imageUrl: `data:image/png;base64,${part.inlineData.data}` };
            }
        }
        return { imageUrl: null, error: "No image data received." };

    } catch (error) {
        console.error("Reimagine error:", error);
        return { imageUrl: null, error: "Failed to reimagine image." };
    }
}
