// KV cache arithmetic for a 4 GB card.
//
// PURE. Takes the model's real attention config as an argument and returns
// bytes. It does not call Ollama, and it does not contain a table of models.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS RATHER THAN A CONSTANT
//
// The plan this implements asserted "FP16 KV cache alone takes ~1-2GB at 8K".
// That number is not a property of 8K — it is a property of the model, and it
// is wrong for the one actually installed here. Measured from Ollama's own
// /api/show for gemma3:4b on 3 Aug 2026:
//
//     block_count ............ 34
//     head_count_kv ........... 4
//     key_length ............ 256
//     value_length .......... 256
//
//     per token = 34 x 4 x (256 + 256) x 2 bytes = 139,264 B = 136 KiB
//     at 8K context ......... 1.06 GiB
//     at 32K context ........ 4.25 GiB   (more than the whole card)
//
// 136 KiB per token is high for a 4B model — Gemma 3 buys quality with a
// head_dim of 256, four times the usual 64, and the KV cache pays for it
// linearly. A model with the same parameter count and head_dim 128 would cost
// a quarter of this. That is exactly why the number has to be read from the
// model rather than assumed from its size, and why this project does not keep
// lookup tables of things the machine can be asked directly.
//
// So: probe, compute, and let the answer decide the context length. The
// alternative — picking 8K because a blog post said so — is how you get an
// assistant that silently offloads to system RAM and answers at 2 tok/s.
// ---------------------------------------------------------------------------

/**
 * Bytes per element for each cache type llama.cpp/Ollama support.
 *
 * These are the real GGML block layouts, not round numbers:
 *   f16   2 bytes, no block structure.
 *   q8_0  32 quantised bytes + one f16 scale per 32 values = 34/32 = 1.0625.
 *   q4_0  16 packed nibbles + one f16 scale per 32 values  = 18/32 = 0.5625.
 *
 * The block overhead is why q8_0 saves 47%, not 50%, and q4_0 saves 72%, not
 * 75%. On a card with ~1.4 GiB spare that 3% is tens of megabytes, which is
 * the difference between fitting and not.
 */
export const CACHE_TYPES = Object.freeze({
    f16: 2.0,
    q8_0: 34 / 32,
    q4_0: 18 / 32
});

/**
 * Ollama ignores the cache type unless flash attention is on.
 *
 * Verified against Ollama's docs and issue tracker, Aug 2026: the default is
 * OLLAMA_KV_CACHE_TYPE=f16 with flash attention OFF, and the quantised cache
 * is only applied on the flash-attention path. Setting the cache type alone is
 * the commonest way to think you have halved your memory and not have.
 *
 * This constant exists so the doctor can check BOTH and report the combination
 * rather than one variable.
 */
export const REQUIRED_ENV = Object.freeze({
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0'
});

/**
 * Pull the attention shape out of an Ollama /api/show `model_info` blob.
 *
 * The keys are namespaced by architecture ("gemma3.block_count",
 * "qwen2.block_count"), so the prefix is discovered rather than assumed — this
 * works for whatever model gets installed next without an edit here.
 *
 * Returns null when the fields are absent. That is a real outcome: some GGUFs
 * omit them, and inventing a plausible head count would produce a confident
 * budget with no relationship to the model. The caller reports "unknown"
 * instead, which is the honest answer and the one that keeps the failure
 * visible.
 *
 * @param {object} modelInfo  the `model_info` object from POST /api/show
 * @returns {{arch:string, layers:number, kvHeads:number, keyLength:number, valueLength:number, contextLength:number|null, slidingWindow:number|null}|null}
 */
export function attentionShape(modelInfo) {
    if (!modelInfo || typeof modelInfo !== 'object') return null;

    const keys = Object.keys(modelInfo);
    const blockKey = keys.find((k) => k.endsWith('.block_count'));
    if (!blockKey) return null;
    const arch = blockKey.slice(0, -'.block_count'.length);

    /* The vision tower of a multimodal model has its own block_count and head
       counts under a `.vision.` namespace. Those layers do not contribute to
       the text KV cache, and counting them would inflate the estimate by most
       of a gigabyte on gemma3:4b. Anything namespaced `vision` is skipped. */
    if (arch.includes('vision')) {
        const textBlockKey = keys.find((k) => k.endsWith('.block_count') && !k.includes('vision'));
        if (!textBlockKey) return null;
        return attentionShape(Object.fromEntries(keys.filter((k) => !k.includes('vision')).map((k) => [k, modelInfo[k]])));
    }

    const num = (suffix) => {
        const v = modelInfo[`${arch}.${suffix}`];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };

    const layers = num('block_count');
    const kvHeads = num('attention.head_count_kv') ?? num('attention.head_count');
    const embedding = num('embedding_length');
    const heads = num('attention.head_count');

    /* key_length/value_length are explicit in well-formed GGUFs. When absent,
       the classical relationship head_dim = embedding / heads holds for every
       architecture that does not override it — and where it does not hold the
       file states the lengths, so this fallback is never reached for those. */
    const keyLength = num('attention.key_length') ?? (embedding && heads ? embedding / heads : null);
    const valueLength = num('attention.value_length') ?? keyLength;

    if (!layers || !kvHeads || !keyLength || !valueLength) return null;

    return {
        arch,
        layers,
        kvHeads,
        keyLength,
        valueLength,
        contextLength: num('context_length'),
        slidingWindow: num('attention.sliding_window')
    };
}

/**
 * Bytes of KV cache per token of context.
 *
 * per layer: kvHeads x keyLength   x bytes   (K)
 *          + kvHeads x valueLength x bytes   (V)
 *
 * This is the upper bound — every layer holding the full context. Models with
 * interleaved sliding-window attention (Gemma 3 among them) can cap the local
 * layers at the window size, and Ollama does apply that where it can. The
 * saving is deliberately NOT modelled here: it depends on the layer pattern,
 * which the GGUF metadata does not publish, and a guess at the ratio would
 * turn a hard bound into a soft one that reads like a hard one.
 *
 * Budgeting against the upper bound means being wrong in the direction that
 * leaves memory free rather than the direction that swaps to system RAM.
 *
 * @param {ReturnType<typeof attentionShape>} shape
 * @param {keyof CACHE_TYPES} cacheType
 */
export function bytesPerToken(shape, cacheType = 'f16') {
    if (!shape) return null;
    const bpe = CACHE_TYPES[cacheType];
    if (!bpe) return null;
    return shape.layers * shape.kvHeads * (shape.keyLength + shape.valueLength) * bpe;
}

/**
 * How much context fits in a memory budget?
 *
 * @param {ReturnType<typeof attentionShape>} shape
 * @param {number} budgetBytes    memory available for the cache alone
 * @param {keyof CACHE_TYPES} cacheType
 * @returns {number} tokens, floored to a multiple of 256 because that is the
 *   granularity num_ctx is worth expressing in — a budget of 8,317 tokens is
 *   false precision built on an estimate of free VRAM.
 */
export function contextThatFits(shape, budgetBytes, cacheType = 'f16') {
    const per = bytesPerToken(shape, cacheType);
    if (!per || !(budgetBytes > 0)) return 0;
    return Math.max(0, Math.floor(budgetBytes / per / 256) * 256);
}

/**
 * Plan a run: what fits, at which cache type, and whether it fits at all.
 *
 * The reserve figures are the part of this that is an estimate rather than a
 * measurement, and they are named so they can be corrected:
 *
 *   displayReserveBytes — the desktop compositor, the browser, and Electron's
 *     own GPU process all hold VRAM before Ollama asks for any. On this
 *     machine that has been observed between 0.6 and 1.0 GiB. Default 0.9.
 *
 *   weightBytes — passed in from `ollama ps`, which reports the real resident
 *     size. Not derived from the parameter count, because the GGUF for a
 *     multimodal model carries a vision tower the parameter count does not
 *     mention: gemma3:4b is "4.3B" and 3.3 GB on disk.
 *
 * @returns {{fits:boolean, cacheType:string, maxContext:number, perTokenBytes:number, cacheBytes:number, freeForCache:number, notes:string[]}}
 */
export function planRun({ shape, totalVramBytes, weightBytes, displayReserveBytes = 0.9 * 1024 ** 3, wantContext = 8192, preferredOrder = ['q8_0', 'q4_0'] }) {
    const notes = [];
    if (!shape) {
        return { fits: false, cacheType: null, maxContext: 0, perTokenBytes: null, cacheBytes: 0, freeForCache: 0, notes: ['attention shape unknown — the model did not publish block_count/head_count_kv, so no budget can be computed'] };
    }

    const freeForCache = totalVramBytes - weightBytes - displayReserveBytes;
    if (freeForCache <= 0) {
        notes.push(`weights (${(weightBytes / 1024 ** 3).toFixed(2)} GiB) plus display reserve (${(displayReserveBytes / 1024 ** 3).toFixed(2)} GiB) already exceed ${(totalVramBytes / 1024 ** 3).toFixed(2)} GiB of VRAM — layers will be offloaded to system RAM whatever the cache type`);
        return { fits: false, cacheType: preferredOrder[0], maxContext: 0, perTokenBytes: bytesPerToken(shape, preferredOrder[0]), cacheBytes: 0, freeForCache, notes };
    }

    for (const cacheType of preferredOrder) {
        const per = bytesPerToken(shape, cacheType);
        const maxContext = contextThatFits(shape, freeForCache, cacheType);
        if (maxContext >= wantContext) {
            return {
                fits: true,
                cacheType,
                maxContext,
                perTokenBytes: per,
                cacheBytes: wantContext * per,
                freeForCache,
                notes: [
                    `${(per / 1024).toFixed(1)} KiB per token at ${cacheType}`,
                    `${wantContext} tokens costs ${(wantContext * per / 1024 ** 3).toFixed(2)} GiB of the ${(freeForCache / 1024 ** 3).toFixed(2)} GiB free`,
                    cacheType !== 'f16' ? 'requires OLLAMA_FLASH_ATTENTION=1 — the cache type is ignored without it' : ''
                ].filter(Boolean)
            };
        }
        notes.push(`${cacheType}: only ${maxContext} tokens fit, short of the ${wantContext} requested`);
    }

    /* Nothing reached the requested context. Report the best available rather
       than failing outright: a 4,096-token Foundry session is useful, and the
       caller can decide. What it must not do is silently ask for 8K anyway. */
    const best = preferredOrder[preferredOrder.length - 1];
    const maxContext = contextThatFits(shape, freeForCache, best);
    notes.push(`the largest context that fits is ${maxContext} tokens at ${best}`);
    return { fits: false, cacheType: best, maxContext, perTokenBytes: bytesPerToken(shape, best), cacheBytes: maxContext * bytesPerToken(shape, best), freeForCache, notes };
}

export default { CACHE_TYPES, REQUIRED_ENV, attentionShape, bytesPerToken, contextThatFits, planRun };
