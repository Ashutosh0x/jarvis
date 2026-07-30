// CONFLICT CORPUS LINT — a benchmark item nobody checked is a benchmark nobody
// can trust. These assertions are about the corpus itself, not about any model.
//
// It earned its place on the first run: k-corr-guidance had `must: [/withdraw/]`
// against a document reading "Merrowfield Systems WITHDREW its guidance".
// "withdrew" does not contain "withdraw", so the item was unpassable — and an
// unpassable item does not look like a typo in the results, it looks like a
// resolver failure. It would have been read as evidence that conflict
// resolution is hard.

import {
    CONFLICT_DOCS, CONFLICT_QUESTIONS, CONFLICT_PAIRS,
    evidenceRetrieved, describeConflictCorpus,
} from '../../../../eval/conflict-corpus.mjs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const byId = Object.fromEntries(CONFLICT_DOCS.map((d) => [d.id, d.text]));

/* --- structural integrity ---------------------------------------------------- */
{
    const ids = CONFLICT_QUESTIONS.map((q) => q.id);
    check('corpus: question ids are unique', new Set(ids).size === ids.length);
    const docIds = CONFLICT_DOCS.map((d) => d.id);
    check('corpus: document ids are unique', new Set(docIds).size === docIds.length);
    check('corpus: every question names a governing document that exists',
        CONFLICT_QUESTIONS.every((q) => byId[q.doc]),
        CONFLICT_QUESTIONS.filter((q) => !byId[q.doc]).map((q) => q.id).join(','));
    check('corpus: every question declares a precedence type',
        CONFLICT_QUESTIONS.every((q) => typeof q.type === 'string' && q.type));
    check('corpus: every question is kind=conflict',
        CONFLICT_QUESTIONS.every((q) => q.kind === 'conflict'));
    check('corpus: every question has at least one must pattern',
        CONFLICT_QUESTIONS.every((q) => Array.isArray(q.must) && q.must.length));
}

/* --- the lint that matters: can the item actually be passed? ------------------ */
{
    const unpassable = CONFLICT_QUESTIONS
        .filter((q) => q.type !== 'unresolvable')
        .filter((q) => !q.must.some((r) => r.test(byId[q.doc])));
    check('corpus: every resolvable item can be satisfied from its governing document',
        unpassable.length === 0, unpassable.map((q) => q.id).join(','));

    /* A trap that fires on the truth marks the correct answer wrong. */
    const selfTrapping = CONFLICT_QUESTIONS
        .filter((q) => q.trap)
        .filter((q) => q.trap.some((r) => r.test(byId[q.doc])));
    check('corpus: no trap fires on its own governing document',
        selfTrapping.length === 0, selfTrapping.map((q) => q.id).join(','));
}

/* --- the anti-overfit guarantee ----------------------------------------------
   The reason this corpus is worth running at all. Without recency-traps, "sort
   by date and take the newest" scores 100%. Without unresolvable items, a
   resolver that always picks something cannot be distinguished from one that
   knows when not to. If either set is ever emptied, the benchmark stops
   measuring analysis and starts certifying a heuristic. */
{
    const d = describeConflictCorpus();
    check('anti-overfit: recency traps exist, so date-sorting cannot win',
        (d.byType['recency-trap'] || 0) >= 5, JSON.stringify(d.byType));
    check('anti-overfit: unresolvable items exist, so always-picking cannot win',
        (d.byType['unresolvable'] || 0) >= 5);
    const defeatable = (d.byType['recency-trap'] || 0) + (d.byType['unresolvable'] || 0);
    check('anti-overfit: they are at least a quarter of the corpus',
        defeatable / d.total >= 0.25, `${defeatable}/${d.total}`);
    check('corpus: all six precedence relations are represented',
        ['supersession', 'recency-trap', 'authority', 'specificity', 'correction', 'unresolvable']
            .every((t) => (d.byType[t] || 0) > 0), JSON.stringify(d.byType));
    check('corpus: large enough for the paired test to have any power',
        d.total >= 30, String(d.total));
    check('corpus: every conflict has both halves present',
        d.docs >= d.total * 2 - 2, `${d.docs} docs for ${d.total} questions`);
}

/* --- unresolvable items must demand the acknowledgement ----------------------
   Their whole purpose is that naming a single figure is the failure, so `must`
   has to require conflict language rather than a value. */
{
    const CONFLICT_WORD = /conflict|disagree|differ|inconsist|determine|contradict|undated|no date|unknown|neither|both|not reconcil|unsigned|untrace|which is later|two authorit/i;
    const wrong = CONFLICT_QUESTIONS
        .filter((q) => q.type === 'unresolvable')
        .filter((q) => !q.must.some((r) => CONFLICT_WORD.test(r.source)));
    check('unresolvable: must-patterns demand an acknowledgement, not a value',
        wrong.length === 0, wrong.map((q) => q.id).join(','));

    /* A trap here would fire on the best answer, which names both figures while
       refusing to choose between them. */
    check('unresolvable: carry no traps',
        CONFLICT_QUESTIONS.filter((q) => q.type === 'unresolvable').every((q) => !q.trap));

    /* DEFECT A2. The original patterns matched bare words that appear in the
       documents themselves — "Neither filing references or amends the other",
       "have not reconciled", "which note is later" — so emitting a document
       verbatim passed. always-longest scored 4/5 by copying. A matcher a copy
       can satisfy measures transcription, not judgement.

       This is the structural fix: no unresolvable pattern may match ANY of the
       62 conflict documents. Checked against all of them, not just the item's
       own pair, because retrieval places other documents in context too. */
    const copyPassable = [];
    for (const q of CONFLICT_QUESTIONS.filter((x) => x.type === 'unresolvable')) {
        for (const d of CONFLICT_DOCS) {
            const hit = q.must.find((r) => r.test(d.text));
            if (hit) copyPassable.push(`${q.id} <- ${d.id} via ${hit}`);
        }
    }
    check('unresolvable: no pattern can be satisfied by copying a document',
        copyPassable.length === 0, copyPassable.slice(0, 3).join(' ; '));

    /* And the patterns must still accept a genuine refusal, or the relation
       becomes unpassable — the k-corr-guidance failure mode, one level up. */
    const GOOD = [
        'The two filings disagree: one gives 640 megawatts and the other 680. I cannot determine which is correct.',
        'There is a discrepancy between these sources, so I would not state a single figure.',
        'These documents conflict and the question cannot be resolved without further evidence.',
    ];
    const BAD = [
        'The Brightwater installed capacity is 640 megawatts.',
        'Ellerby regulatory filing R-91, also dated 9 May 2026, gives the capacity as 680 megawatts. Neither filing references or amends the other.',
    ];
    const u = CONFLICT_QUESTIONS.find((q) => q.type === 'unresolvable');
    check('unresolvable: a genuine refusal still passes',
        GOOD.every((g) => u.must.some((r) => r.test(g))),
        GOOD.filter((g) => !u.must.some((r) => r.test(g))).join(' | '));
    check('unresolvable: picking a side, or quoting the document, still fails',
        BAD.every((b) => !u.must.some((r) => r.test(b))),
        BAD.filter((b) => u.must.some((r) => r.test(b))).join(' | '));
}

/* --- contamination: the answers must not be knowable without the documents ---
   Fictional entities are the mechanism. If a real organisation appeared here a
   model could answer from pretraining and score well while resolving nothing —
   the failure mode WorldReasoner needed a whole contamination filter to expose
   (GPT-5.4: 69.2% -> 52.7% once pre-cutoff questions were removed). */
{
    const REAL = /\b(goldman|morgan stanley|jpmorgan|nvidia|apple|microsoft|tesla|amazon|google|meta|openai|anthropic|coinbase|binance|kalshi|polymarket|ethereum|bitcoin|solana|arbitrum)\b/i;
    const leaked = CONFLICT_DOCS.filter((d) => REAL.test(d.text));
    check('contamination: no real entity appears in the conflict documents',
        leaked.length === 0, leaked.map((d) => d.id).join(','));
    const leakedQ = CONFLICT_QUESTIONS.filter((q) => REAL.test(q.q));
    check('contamination: nor in the questions', leakedQ.length === 0, leakedQ.map((q) => q.id).join(','));
}

/* --- minimal required evidence -----------------------------------------------
   Separates the two ways a conflict item can fail: recall never surfaced the
   opposing document (a retrieval failure) versus both were shown and the wrong
   one was chosen (a resolver failure). Without this split every fix gets aimed
   at whichever subsystem was most recently touched. */
{
    check('pairs: every question declares its minimal evidence',
        CONFLICT_QUESTIONS.every((q) => Array.isArray(CONFLICT_PAIRS[q.id])),
        CONFLICT_QUESTIONS.filter((q) => !CONFLICT_PAIRS[q.id]).map((q) => q.id).join(','));
    check('pairs: no orphan entries',
        Object.keys(CONFLICT_PAIRS).every((id) => CONFLICT_QUESTIONS.some((q) => q.id === id)));
    check('pairs: both halves name real documents',
        Object.values(CONFLICT_PAIRS).every(([a, b]) => byId[a] && byId[b]));
    check('pairs: the two halves are distinct documents',
        Object.values(CONFLICT_PAIRS).every(([a, b]) => a !== b));

    /* The governing slot must agree with the question's own `doc`, or the
       retrieval split would be measured against the wrong side. */
    const mismatched = CONFLICT_QUESTIONS.filter((q) => CONFLICT_PAIRS[q.id][0] !== q.doc);
    check('pairs: governing slot matches the question governing document',
        mismatched.length === 0, mismatched.map((q) => `${q.id}:${q.doc}!=${CONFLICT_PAIRS[q.id][0]}`).join(','));

    /* Every document should be used exactly once, or a conflict is missing a
       half and something is silently untested. */
    const used = Object.values(CONFLICT_PAIRS).flat();
    check('pairs: every conflict document is used exactly once',
        used.length === CONFLICT_DOCS.length && new Set(used).size === used.length,
        `${used.length} used of ${CONFLICT_DOCS.length}`);

    /* The detector itself. It runs on rendered context text, not ids, so it has
       to survive whitespace collapsing and find the probe in a larger haystack. */
    const q0 = CONFLICT_QUESTIONS[0];
    const [gov, opp] = CONFLICT_PAIRS[q0.id];
    check('retrieved: sees both halves when both are present',
        evidenceRetrieved(q0.id, `noise\n${byId[gov]}\n\n${byId[opp]}\nmore noise`).both === true);
    check('retrieved: reports the opposing half missing when it is absent',
        evidenceRetrieved(q0.id, byId[gov]).opposing === false);
    check('retrieved: reports the governing half missing when it is absent',
        evidenceRetrieved(q0.id, byId[opp]).governing === false);
    check('retrieved: empty context finds nothing',
        evidenceRetrieved(q0.id, '').both === false);
    check('retrieved: survives whitespace and case differences',
        evidenceRetrieved(q0.id, `${byId[gov].toUpperCase().replace(/ /g, '   ')}\n${byId[opp]}`).governing === true);
    check('retrieved: an unknown question id yields null, not a false positive',
        evidenceRetrieved('no-such-question', 'anything') === null);

    /* Every probe must be unique to its own document, or the detector will
       report a half retrieved because a DIFFERENT document happened to match. */
    const collisions = [];
    for (const [id, [a, b]] of Object.entries(CONFLICT_PAIRS)) {
        for (const target of [a, b]) {
            const others = CONFLICT_DOCS.filter((d) => d.id !== target).map((d) => d.text).join('\n');
            const r = evidenceRetrieved(id, others);
            if ((target === a && r.governing) || (target === b && r.opposing)) collisions.push(`${id}:${target}`);
        }
    }
    check('retrieved: no probe matches a document other than its own',
        collisions.length === 0, collisions.join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
