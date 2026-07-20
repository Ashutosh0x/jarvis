import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

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

export async function generateContentLocal(messages, onChunk) {
    const { url, model } = getLocalConfig();
    const response = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages,
            stream: true,
            keep_alive: '60m', // keep Gemma in RAM — no cold-load pause mid-conversation
        }),
    });

    if (!response.ok) {
        throw new Error(`Ollama error ${response.status}: is '${model}' pulled? Try: ollama pull ${model}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

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
                    fullText += piece;
                    if (onChunk) onChunk(piece);
                }
            } catch (e) {
                console.warn('Ollama stream: skipping malformed line', line.slice(0, 80));
            }
        }
    }

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
