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
