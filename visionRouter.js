// ---------------------------------------------------------------------------
// Which vision backend parses a document, and how its pages are put back
// together. Pure: no sockets, no filesystem, no clock — every decision here is
// unit-testable, the same arrangement chainWatch.js uses.
//
// Two backends, and they are not interchangeable:
//
//   Unlimited-OCR (SGLang, :10000) parses many pages in ONE pass with
//   constant-memory attention. It is the better answer whenever it exists,
//   and it needs an NVIDIA card with 6-8GB of VRAM.
//
//   VisionPsy-Nano (llama-server, :8772) is ~300MB on CPU and beats a model
//   nine times its size on DocVQA (83.5 vs 75.8) and TextVQA (79.5 vs 57.8).
//   Its limit is structural rather than qualitative: the model card says "one
//   image per query", so pages are looped and stitched here instead.
//
// The point of the fallback is not speed. Without it, a machine with no
// NVIDIA GPU cannot parse a document at all, which also means the Downloads
// watcher never reaches its ragService.ingest() call and nothing a user reads
// ever becomes durable memory.
// ---------------------------------------------------------------------------

/** Backends in the order they are preferred when nothing is pinned. */
const BACKENDS = Object.freeze({
    UNLIMITED_OCR: 'unlimited-ocr',
    VISIONPSY: 'visionpsy',
});

/**
 * Picks the backend for one request.
 *
 * Unlimited-OCR wins by default when it is up: it was here first, it handles
 * multi-page in a single pass, and silently demoting it would be a regression
 * for the users who went to the trouble of standing up the GPU server.
 *
 * @param {{ocrAvailable?: boolean, visionAvailable?: boolean, preferred?: string}} opts
 * @returns {string|null} a BACKENDS value, or null when nothing can serve it
 */
function chooseBackend(opts = {}) {
    const ocr = opts.ocrAvailable === true;
    const vision = opts.visionAvailable === true;
    const preferred = opts.preferred || null;

    // An explicit preference is honoured only if that backend is actually up.
    // Falling through to the other one is deliberate: the caller asked for a
    // parse, and a document parsed by the second choice beats no parse at all.
    if (preferred === BACKENDS.UNLIMITED_OCR && ocr) return BACKENDS.UNLIMITED_OCR;
    if (preferred === BACKENDS.VISIONPSY && vision) return BACKENDS.VISIONPSY;

    if (ocr) return BACKENDS.UNLIMITED_OCR;
    if (vision) return BACKENDS.VISIONPSY;
    return null;
}

/**
 * The instruction sent with each page.
 *
 * Asks for Markdown rather than free-form description because the output has
 * one real consumer — ragService.ingest() — and prose about a table is not
 * recallable in the way the table itself is.
 */
function pagePrompt(pageIndex, totalPages) {
    const where = totalPages > 1 ? ` This is page ${pageIndex + 1} of ${totalPages}.` : '';
    return (
        'Transcribe this document page into Markdown. Preserve headings, lists ' +
        'and table structure. Output only the transcription, with no commentary ' +
        'and no invented content: if part of the page is unreadable, omit it ' +
        'rather than guessing.' + where
    );
}

/**
 * OpenAI-compatible chat payload for llama-server.
 *
 * Same shape the Unlimited-OCR path already builds, so the transport code is
 * shared rather than reinvented — llama-server and SGLang both speak
 * /v1/chat/completions with image_url data URLs.
 */
function buildVisionPayload({ imageBase64, prompt, model = 'visionpsy', maxTokens = 2048 }) {
    return {
        model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                {
                    type: 'image_url',
                    image_url: { url: `data:image/png;base64,${imageBase64}` },
                },
            ],
        }],
    };
}

/**
 * Stitches per-page transcriptions into one document.
 *
 * Pages that failed are marked rather than dropped. A silently missing page
 * turns into a confident, wrong answer later, once the text is in the corpus
 * and nothing records that a gap was ever there.
 *
 * @param {Array<{page: number, markdown?: string, error?: string}>} pages
 * @returns {{markdown: string, ok: number, failed: number}}
 */
function assemblePages(pages) {
    const list = Array.isArray(pages) ? pages : [];
    if (list.length === 0) return { markdown: '', ok: 0, failed: 0 };

    let ok = 0;
    let failed = 0;
    const parts = [];

    for (const p of list) {
        const text = typeof p?.markdown === 'string' ? p.markdown.trim() : '';
        if (text) {
            ok++;
            parts.push(list.length > 1 ? `<!-- page ${p.page} -->\n${text}` : text);
        } else {
            failed++;
            parts.push(`<!-- page ${p.page}: not parsed (${p?.error || 'empty response'}) -->`);
        }
    }

    return { markdown: parts.join('\n\n'), ok, failed };
}

/**
 * True when a result is worth handing to ragService.ingest().
 *
 * A parse where every page failed still produces well-formed Markdown — a
 * string of HTML comments — and ingesting that would put a document into
 * long-term memory that contains none of its content.
 */
function isWorthIngesting(result) {
    return !!result && result.ok > 0 && typeof result.markdown === 'string' &&
        result.markdown.trim().length > 0;
}

module.exports = {
    BACKENDS,
    chooseBackend,
    pagePrompt,
    buildVisionPayload,
    assemblePages,
    isWorthIngesting,
};
