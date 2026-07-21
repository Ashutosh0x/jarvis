/**
 * @fileoverview Failure signals — learning from real use, without training.
 *
 * PURE: analysis over the interaction log. No network, no model, no clock
 * except where passed.
 *
 * The 1000-prompt harness measures routing against prompts I wrote, which means
 * it measures my imagination. This measures the opposite: what actually went
 * wrong in front of the user. Three signals, all of them things a person does
 * when an assistant fails them, and none requiring them to fill in a rating:
 *
 *   REPHRASE   — asking nearly the same thing again within a short window.
 *                Nobody repeats themselves when the first answer landed.
 *   CORRECTION — "no", "that's wrong", "not what I meant". Explicit.
 *   FALLBACK   — a question that looks like it had a deterministic handler but
 *                reached the model instead. That is the failure mode this
 *                project keeps finding: the model answers from nothing.
 *
 * None of this changes a weight. It ranks where the ROUTER is wrong on real
 * traffic, so the next fix is chosen by evidence rather than by guess.
 */

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'of', 'to', 'in', 'on', 'for', 'and', 'or',
    'what', 'whats', 'how', 'me', 'my', 'you', 'your', 'can', 'do', 'does', 'did', 'please', 'jarvis', 'sir']);

export function tokens(text) {
    return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
}

/** Overlap of the smaller set — asymmetric on purpose, since a rephrase is
 *  often shorter than the original ("apple sharpe" after "sharpe ratio of apple"). */
export function similarity(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared++;
    return shared / Math.min(A.size, B.size);
}

export const REPHRASE_THRESHOLD = 0.6;
export const REPHRASE_WINDOW_MS = 120000;   // two minutes

const CORRECTION = /^(no|nope|wrong|that'?s (wrong|not right|incorrect)|not what i (meant|asked)|i said|thats not it|try again|incorrect)\b/i;

/* Shapes that a deterministic handler exists for. If one of these reached
   AI_COMMAND, the router missed — the model then answered a factual question
   with no data, which is how this project got a fabricated CVE severity and a
   $17,500 bitcoin. */
const DETERMINISTIC_SHAPES = [
    { name: 'price', re: /\b(price of|how much is|trading at|stock price)\b/i },
    { name: 'quant', re: /\b(sharpe|volatility|drawdown|beta of|annualized return|analyze)\b/i },
    { name: 'chain', re: /\b(gas on|balance of|portfolio of|0x[0-9a-f]{6,}|\.eth\b)\b/i },
    { name: 'issuance', re: /\b(mint|minted|burn|burned)\b.*\b(usdc|usdt|dai|stablecoin)\b/i },
    { name: 'news', re: /\b(news|headlines|latest on|what'?s happening with)\b/i },
    { name: 'security', re: /\bCVE-\d{4}-\d{4,7}\b|\b(vulnerabilit(y|ies)|advisor(y|ies))\b/i },
    { name: 'prediction', re: /\b(odds|prediction market|polymarket|kalshi)\b/i },
    { name: 'system', re: /\b(cpu|memory|ram|disk|battery|wifi|network)\b/i },
];

/**
 * @param {Array<{ts, input, intent, latencyMs, ok, response}>} turns
 * @returns {{rephrases, corrections, fallbacks, byIntent, worstIntents, total}}
 */
export function analyze(turns) {
    const rows = (turns || []).filter(t => t && t.input);
    const rephrases = [];
    const corrections = [];
    const fallbacks = [];

    for (let i = 0; i < rows.length; i++) {
        const cur = rows[i], prev = rows[i - 1];

        if (prev && CORRECTION.test(String(cur.input).trim())) {
            corrections.push({ at: cur.ts, correcting: prev.input, intent: prev.intent, said: cur.input });
        }

        if (prev && (cur.ts - prev.ts) < REPHRASE_WINDOW_MS) {
            const sim = similarity(cur.input, prev.input);
            // Identical text is a retry, not a rephrase; both signal failure,
            // but a near-match is the stronger evidence of being misunderstood.
            if (sim >= REPHRASE_THRESHOLD) {
                rephrases.push({ at: cur.ts, first: prev.input, second: cur.input, similarity: +sim.toFixed(2), intent: prev.intent });
            }
        }

        if (cur.intent === 'AI_COMMAND') {
            const shape = DETERMINISTIC_SHAPES.find(s => s.re.test(cur.input));
            if (shape) fallbacks.push({ at: cur.ts, input: cur.input, shouldBe: shape.name, latencyMs: cur.latencyMs });
        }
    }

    /* Per-intent failure counts. An intent that is often followed by a rephrase
       is one whose ANSWER is wrong even when the routing is right. */
    const byIntent = {};
    const bump = (intent, key) => {
        const k = intent || 'NONE';
        (byIntent[k] = byIntent[k] || { rephrased: 0, corrected: 0, turns: 0 })[key]++;
    };
    for (const t of rows) bump(t.intent, 'turns');
    for (const r of rephrases) bump(r.intent, 'rephrased');
    for (const c of corrections) bump(c.intent, 'corrected');

    const worstIntents = Object.entries(byIntent)
        .map(([intent, s]) => ({ intent, ...s, failRate: s.turns ? (s.rephrased + s.corrected) / s.turns : 0 }))
        // Below 3 turns a single rephrase reads as 33% and means nothing.
        .filter(x => x.turns >= 3 && x.failRate > 0)
        .sort((a, b) => b.failRate - a.failRate);

    return { total: rows.length, rephrases, corrections, fallbacks, byIntent, worstIntents };
}

/* Severity weights. A correction is unambiguous — the user said so. A rephrase
   is the weakest: it may mean I misunderstood, or merely that they thought of a
   better wording. Weighting them equally would let the noisiest signal dominate
   the ranking. */
export const WEIGHTS = { corrected: 1.0, abandoned: 1.0, fallback: 0.8, rephrased: 0.6 };

/* A failure signal followed by SILENCE. If the next turn is far away (or there
   is no next turn), the user stopped rather than continued — the strongest
   implicit signal available, and the only one that needs no wording heuristic.
   Deliberately NOT inferred from "they opened a browser": this app cannot see
   why another window was focused, and guessing intent from window titles is the
   kind of inference that produces confident wrong answers. */
export const ABANDON_GAP_MS = 600000;   // ten minutes

/**
 * Turns until a question was resolved. A run of rephrases on one subject is a
 * single struggle, not N independent failures — counting it as N would rank a
 * path by how stubborn the user was rather than how wrong the path was.
 * @returns {Array<{intent, turns, inputs, resolved}>} chains of length >= 2
 */
export function resolutionChains(turns, nowTs) {
    const rows = (turns || []).filter(t => t && t.input);
    const chains = [];
    let cur = null;
    for (let i = 0; i < rows.length; i++) {
        const t = rows[i], prev = rows[i - 1];
        const linked = prev && (t.ts - prev.ts) < REPHRASE_WINDOW_MS &&
            (similarity(t.input, prev.input) >= REPHRASE_THRESHOLD || CORRECTION.test(String(t.input).trim()));
        if (linked) {
            if (!cur) cur = { intent: prev.intent, inputs: [prev.input], startTs: prev.ts };
            cur.inputs.push(t.input);
            cur.endTs = t.ts;
        } else if (cur) {
            chains.push(cur); cur = null;
        }
    }
    if (cur) chains.push(cur);

    const last = rows.length ? rows[rows.length - 1].ts : 0;
    const horizon = nowTs || last;
    return chains.map(c => {
        const after = rows.find(r => r.ts > c.endTs);
        // Resolved = they moved on to something else. Abandoned = they stopped.
        const resolved = !!after && (after.ts - c.endTs) < ABANDON_GAP_MS;
        const stopped = !after && (horizon - c.endTs) >= ABANDON_GAP_MS;
        return { intent: c.intent || 'NONE', turns: c.inputs.length, inputs: c.inputs, resolved, abandoned: stopped };
    });
}

/**
 * Weighted health per intent. Higher score = worse.
 * @returns {Array<{intent, turns, score, per100, signals}>}
 */
export function health(analysis, chains) {
    const rows = [];
    const abandoned = {};
    for (const c of (chains || [])) if (c.abandoned) abandoned[c.intent] = (abandoned[c.intent] || 0) + 1;

    for (const [intent, s] of Object.entries(analysis.byIntent || {})) {
        const fb = (analysis.fallbacks || []).filter(f => intent === 'AI_COMMAND').length;
        const ab = abandoned[intent] || 0;
        const score = s.corrected * WEIGHTS.corrected + s.rephrased * WEIGHTS.rephrased +
            ab * WEIGHTS.abandoned + (intent === 'AI_COMMAND' ? fb * WEIGHTS.fallback : 0);
        rows.push({
            intent, turns: s.turns, score: +score.toFixed(1),
            // Per-100 so a heavily-used path is not flagged merely for being popular.
            per100: s.turns ? +(score / s.turns * 100).toFixed(1) : 0,
            signals: { corrected: s.corrected, rephrased: s.rephrased, abandoned: ab },
        });
    }
    return rows.filter(r => r.turns >= 3).sort((a, b) => b.per100 - a.per100);
}

/** Fallbacks grouped by the handler that should have caught them. */
export function rankFallbacks(fallbacks) {
    const groups = {};
    for (const f of fallbacks || []) (groups[f.shouldBe] = groups[f.shouldBe] || []).push(f);
    return Object.entries(groups)
        .map(([handler, list]) => ({
            handler, count: list.length,
            wastedMs: list.reduce((s, x) => s + (x.latencyMs || 0), 0),
            examples: [...new Set(list.map(x => x.input))].slice(0, 3),
        }))
        .sort((a, b) => b.count - a.count);
}

/** Spoken, and deliberately about the SYSTEM rather than the user. */
export function describeFailures(a) {
    if (!a || !a.total) return 'I have no interaction history to learn from yet, Sir.';
    const bits = [];
    if (a.fallbacks.length) {
        const top = rankFallbacks(a.fallbacks)[0];
        bits.push(`${a.fallbacks.length} question${a.fallbacks.length === 1 ? '' : 's'} reached the model that a handler should have answered, mostly ${top.handler}`);
    }
    if (a.rephrases.length) bits.push(`you rephrased ${a.rephrases.length} time${a.rephrases.length === 1 ? '' : 's'}`);
    if (a.corrections.length) bits.push(`you corrected me ${a.corrections.length} time${a.corrections.length === 1 ? '' : 's'}`);
    if (!bits.length) return `Across ${a.total} turns I found no rephrases, corrections, or missed handlers, Sir.`;
    const worst = a.worstIntents[0];
    return `Across ${a.total} turns, Sir: ${bits.join(', ')}.` +
        (worst ? ` The weakest path is ${worst.intent}, failing ${Math.round(worst.failRate * 100)} percent of its ${worst.turns} turns.` : '');
}

/* Promotion gate. A signal becomes a SUGGESTION, never an automatic rule change.
   Two reasons, one measured here and one from the literature: repeated rephrases
   of "how much is intel" may mean the symbol resolver is thin, not that routing
   is wrong — and arXiv 2507.23158 finds harvested implicit feedback works as a
   lens on user behaviour but is unreliable as a direct learning signal on
   complex inputs. So this ranks candidates for review and stops there. */
export const PROMOTE_MIN_COUNT = 3;

export function suggestions(analysis, chains) {
    const out = [];
    for (const g of rankFallbacks(analysis.fallbacks)) {
        if (g.count >= PROMOTE_MIN_COUNT) {
            out.push({
                kind: 'router', confidence: 'review',
                what: `${g.count} questions matching the ${g.handler} shape reached the model`,
                evidence: g.examples,
                note: 'May be a missing route OR a thin resolver behind an existing route — check which before editing the parser.',
            });
        }
    }
    for (const h of health(analysis, chains)) {
        if (h.signals.abandoned >= 2) {
            out.push({
                kind: 'answer-quality', confidence: 'review',
                what: `${h.intent} was abandoned ${h.signals.abandoned} times`,
                evidence: [], note: 'Routing may be right while the ANSWER is unusable.',
            });
        }
    }
    return out;
}

export default {
    tokens, similarity, analyze, rankFallbacks, describeFailures,
    resolutionChains, health, suggestions,
    REPHRASE_THRESHOLD, REPHRASE_WINDOW_MS, ABANDON_GAP_MS, WEIGHTS, PROMOTE_MIN_COUNT,
};
