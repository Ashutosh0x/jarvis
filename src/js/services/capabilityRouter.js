// Semantic capability routing.
//
// Picks a capability by MEANING instead of spelling: the query and every
// capability's examples are embedded with the local nomic-embed-text model, and
// the nearest capability wins. Adding an ability becomes adding a manifest.
//
// This is the layer that fixes the class of bug the regex could only fix one
// sentence at a time — "latest trending meme coin search" failed because the
// verb was at the end, and no pattern anticipated that.
//
// ---------------------------------------------------------------------------
// THREE RULES, EACH ENFORCED HERE RATHER THAN TRUSTED
//
// 1. ONLY READ-ONLY CAPABILITIES ARE REACHABLE. Filtered from the manifest by
//    `effects`, not by a caller remembering to. "empty the recycle bin" and
//    "don't empty the recycle bin" are embedding neighbours; nothing about
//    cosine similarity separates them, so nothing destructive is selectable
//    this way. Verified by a test that asserts the negated form cannot reach a
//    destructive capability even when it is the nearest match.
//
// 2. A FLOOR, AND A MARGIN. A nearest neighbour always exists — that is what
//    "nearest" means — so similarity alone will happily route "thank you" to
//    whichever capability is least unlike it. Below MIN_SCORE nothing is
//    chosen, and when the top two are within MARGIN the result is ambiguous
//    and also declines. Both are refusals, not guesses.
//
// 3. THE EMBEDDER MAY BE ABSENT. Ollama is optional and can be down. Then this
//    returns null and the caller keeps its deterministic path, which still
//    works. Degrading to "no opinion" is correct; degrading to a random
//    capability is not.
// ---------------------------------------------------------------------------

import { semanticallyRoutable, classifyFreshness } from './capabilities.js';

export const ROUTER_LIMITS = Object.freeze({
    /* Tuned on the labelled set in the tests. Below this, the nearest match is
       noise — "thank you" scores ~0.3 against everything. */
    MIN_SCORE: 0.55,
    /* If two capabilities are this close, the query genuinely does not
       distinguish them and picking one is a coin flip. */
    MARGIN: 0.04
});

export function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Build the capability index.
 *
 * Each capability is represented by the CENTROID of its examples plus the
 * examples themselves, and scored on the best of the two. The centroid
 * generalises to phrasings nobody wrote down; the individual examples keep a
 * close paraphrase of a real utterance scoring high even when the centroid has
 * been pulled elsewhere by a diverse example set. Centroid alone measurably
 * loses the specific sentences it was built from.
 *
 * @param {(texts:string[]) => Promise<number[][]>} embed
 */
export async function buildIndex(embed) {
    const caps = semanticallyRoutable();
    const flat = [];
    for (const c of caps) for (const ex of c.examples) flat.push(ex);

    const vectors = await embed(flat);
    if (!Array.isArray(vectors) || vectors.length !== flat.length) return null;

    const index = [];
    let i = 0;
    for (const c of caps) {
        const vecs = c.examples.map(() => vectors[i++]);
        if (vecs.some((v) => !Array.isArray(v))) return null;
        const dim = vecs[0].length;
        const centroid = new Array(dim).fill(0);
        for (const v of vecs) for (let d = 0; d < dim; d++) centroid[d] += v[d] / vecs.length;
        index.push({ capability: c, centroid, exampleVectors: vecs });
    }
    return index;
}

/**
 * Route one utterance.
 *
 * @returns {{capability, score, runnerUp, freshness, reason}|null}
 *   null when nothing is confidently selectable — which is a valid, common
 *   answer and not a failure.
 */
export function routeWithIndex(index, queryVector, text = '') {
    if (!index || !Array.isArray(queryVector)) return null;

    const scored = index.map(({ capability, centroid, exampleVectors }) => {
        const byCentroid = cosine(queryVector, centroid);
        const byExample = Math.max(...exampleVectors.map((v) => cosine(queryVector, v)));
        return { capability, score: Math.max(byCentroid, byExample) };
    }).sort((a, b) => b.score - a.score);

    const top = scored[0];
    const second = scored[1];
    if (!top || top.score < ROUTER_LIMITS.MIN_SCORE) {
        return null;   // nothing is close enough to be a real match
    }
    if (second && (top.score - second.score) < ROUTER_LIMITS.MARGIN) {
        return null;   // genuinely ambiguous; the caller should ask or fall back
    }

    /* DEFENCE IN DEPTH. The index is already filtered to read-only, so this
       can only fire if the manifest changes underneath. It is cheap, and the
       thing it prevents is a destructive action chosen by cosine similarity. */
    if (top.capability.effects !== 'read') return null;

    return {
        capability: top.capability,
        score: Number(top.score.toFixed(4)),
        runnerUp: second ? { name: second.capability.name, score: Number(second.score.toFixed(4)) } : null,
        freshness: classifyFreshness(text),
        reason: 'semantic'
    };
}

/**
 * Convenience wrapper: embed the query and route.
 * Returns null if the embedder is unavailable — the caller keeps its
 * deterministic path rather than losing routing entirely.
 */
export async function route(index, embed, text) {
    if (!index) return null;
    try {
        const [vec] = await embed([String(text ?? '')]);
        if (!Array.isArray(vec)) return null;
        return routeWithIndex(index, vec, text);
    } catch {
        return null;
    }
}

export default { buildIndex, route, routeWithIndex, cosine, ROUTER_LIMITS };
