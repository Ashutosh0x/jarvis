/**
 * CONFLICT LABELS — when two pieces of evidence disagree, which one governs?
 *
 * WHY THIS IS A NEW KIND AND NOT MORE `contradiction` ITEMS. The existing
 * contradiction cases are FALSE-PREMISE questions: the user asserts something
 * untrue ("kalshi quotes in whole cents, so 0.0120 is 120 cents, correct") and
 * the failure is agreeing. That measures resistance to pressure from the USER.
 * This file measures something different — two retrieved DOCUMENTS disagree with
 * each other, and the failure is picking the wrong one, or picking either one
 * when neither governs. Folding them into a single number would hide both.
 *
 * WHY IT EXISTS. The paired run of 22 Jul 2026 (eval/paired-stats.mjs over
 * answers-2026-07-22T05-20-26-567Z.jsonl) found retrieval worth +34.9pp
 * overall, p=0.001 — and traced the entire gain to ONE category:
 *
 *     no-context -> rag    answerable    +68.2pp
 *                          absent         +0.0pp
 *                          contradiction  +0.0pp
 *                          stale          +0.0pp
 *
 * Exactly zero on everything that is not a lookup. Jarvis got much better at
 * FINDING information and not at all better at RECONCILING it.
 *
 * DELIBERATELY FICTIONAL ENTITIES. Every organisation, identifier and figure
 * below is invented. That is the point, not a shortcut: a model that has read
 * about the real thing during pretraining can answer from memory and score well
 * while resolving nothing. WorldReasoner (arXiv 2606.11816) had to build a whole
 * contamination filter for this — GPT-5.4's no-retrieval accuracy fell from
 * 69.2% to 52.7% once questions predating its cutoff were removed. Fictional
 * evidence makes the corpus contamination-proof by construction: there is no
 * prior to fall back on, so the only route to a correct answer is the documents.
 *
 * NO TRAPS ON MOST ITEMS, AND THAT IS DELIBERATE. The obvious design gives each
 * item a trap on the superseded value. It is wrong. If the governing figure is
 * 14,900,000 and the superseded one is 12,400,000, a trap on the latter fires on
 * the BEST possible answer — "raised from $12.4M to $14.9M" — and scores correct
 * reasoning as a failure. Requiring the governing value in `must` already fails
 * an answer that offers only the stale one, because `must` will not match. Traps
 * are therefore kept only where repeating the claim AT ALL is the failure:
 * retractions and withdrawals.
 *
 * THE ANTI-OVERFIT SET. Six items (type `recency-trap`) are cases where the
 * NEWER document does not govern. Without them, `sort by date, take the first`
 * scores 100% and the benchmark certifies a one-line heuristic as analysis.
 * Five more (`unresolvable`) have no winner at all, where the only correct
 * output is to report the conflict — so a resolver that always picks something
 * cannot pass either. Together they are a third of the corpus, and any engine
 * measured against it has to earn those eleven separately.
 *
 * PRECEDENCE TYPES COVERED, all domain-general:
 *   supersession    a later instrument replaces an earlier one
 *   recency-trap    the later document is NOT the governing one
 *   authority       primary source over secondary reporting
 *   specificity     a narrow rule over a general one
 *   correction      explicit erratum, retraction or withdrawal
 *   unresolvable    genuine conflict; reporting it is the correct answer
 *
 * THIS MEASURES THE PIPELINE, NOT ONLY THE RESOLVER. Both sides of a conflict
 * have to be retrieved before either can be weighed, so an item can fail because
 * recall surfaced one document and not the other. That is a real failure of the
 * system and is left in the measurement rather than engineered away.
 */

/** Both halves of every conflict, merged into the retrieval corpus so they
 *  compete against the general distractors rather than a curated shortlist. */
export const CONFLICT_DOCS = [
    /* --- supersession: the later instrument governs ----------------------- */
    { id: 'cf-note-orig', source: 'document', text: 'Vantrix Capital pricing supplement dated 4 March 2026 registers an aggregate principal amount of $12,400,000 for the Series K notes.' },
    { id: 'cf-note-amend', source: 'document', text: 'Vantrix Capital amended pricing supplement dated 19 March 2026 restates the Series K aggregate principal amount as $14,900,000 and supersedes the supplement dated 4 March 2026 in its entirety.' },

    { id: 'cf-guide-old', source: 'document', text: 'Halbrook Clinical Standard, 2023 revision: the referral threshold for the Prentiss index is 140.' },
    { id: 'cf-guide-new', source: 'document', text: 'Halbrook Clinical Standard, 2026 revision: the referral threshold for the Prentiss index is lowered to 130, replacing the 2023 revision.' },

    { id: 'cf-tx-pending', source: 'document', text: 'Pending transaction 0xa41f on the Corvid testnet shows a transfer of 3.2 SOLT and has not been included in a block.' },
    { id: 'cf-tx-confirmed', source: 'document', text: 'Corvid testnet block 8,113,204 contains the replacement for transaction 0xa41f, which settled at 3.0 SOLT. The pending version was dropped from the mempool.' },

    { id: 'cf-headcount-q1', source: 'document', text: 'Merrowfield Systems reported 1,200 full-time employees in its first-quarter 2026 statement.' },
    { id: 'cf-headcount-q3', source: 'document', text: 'Merrowfield Systems reported 1,050 full-time employees in its third-quarter 2026 statement, the most recent period reported.' },

    { id: 'cf-ratelimit-v1', source: 'document', text: 'Alderin API reference, version 1: all authenticated endpoints are limited to 100 requests per minute.' },
    { id: 'cf-ratelimit-v2', source: 'document', text: 'Alderin API reference, version 2, effective 1 June 2026: the authenticated endpoint limit is raised to 250 requests per minute. Version 1 is withdrawn.' },

    /* --- recency trap: the LATER document does not govern ------------------ */
    { id: 'cf-primary-filing', source: 'document', text: 'Vantrix Capital final pricing supplement filed 17 July 2026 states the Series M offering size as $17,320,000.' },
    { id: 'cf-later-blog', source: 'document', text: 'Marketwatch-style summary posted 24 July 2026: Vantrix priced its Series M notes at roughly $17.5 million last week, according to people familiar with the deal.' },

    { id: 'cf-spec-final', source: 'document', text: 'Coldharbour Protocol specification, FINAL, ratified 3 March 2026: the handshake timeout is 30 seconds.' },
    { id: 'cf-spec-draft', source: 'document', text: 'Coldharbour Protocol working draft circulated 19 March 2026, marked DRAFT — NOT FOR IMPLEMENTATION: proposes changing the handshake timeout to 45 seconds. The draft has not been ratified.' },

    { id: 'cf-vendor-advisory', source: 'document', text: 'Nyxsoft security advisory NYX-2026-0041, published 2 May 2026: builds 5.2.0 through 5.2.4 are NOT affected by the deserialisation issue. Only 5.1.x is affected.' },
    { id: 'cf-aggregator-late', source: 'document', text: 'Third-party vulnerability aggregator entry updated 20 May 2026 lists Nyxsoft 5.2.x as affected. The entry cites an unverified pre-release draft and has not been reconciled with the vendor advisory.' },

    { id: 'cf-audited', source: 'document', text: 'Merrowfield Systems audited annual accounts for 2025, signed 28 February 2026, report full-year revenue of 412.6 million.' },
    { id: 'cf-prelim-later', source: 'document', text: 'A preliminary unaudited estimate of Merrowfield Systems 2025 revenue, circulated 11 March 2026, gives 419 million and is expressly labelled preliminary and subject to audit adjustment.' },

    { id: 'cf-syndicated', source: 'document', text: 'Republished 6 June 2026 on a syndication network; originally published 12 August 2024. States the Alderin storage tier ceiling as 2 terabytes.' },
    { id: 'cf-vendor-current', source: 'document', text: 'Alderin product documentation, last reviewed 2 May 2026, states the storage tier ceiling as 8 terabytes.' },

    { id: 'cf-tenk', source: 'document', text: 'Merrowfield Systems annual report filed 12 February 2026 states that the Brightwater facility has an installed capacity of 640 megawatts.' },
    { id: 'cf-call-paraphrase', source: 'document', text: 'A trade-press write-up of the Merrowfield earnings call, published 3 March 2026, paraphrases management as putting Brightwater capacity "at around 700 megawatts". No transcript passage is quoted.' },

    /* --- authority: primary source over secondary reporting ---------------- */
    { id: 'cf-coupon-filing', source: 'document', text: 'Vantrix Capital Series K pricing supplement sets the contingent coupon rate at 2.0625 percent per quarter.' },
    { id: 'cf-coupon-news', source: 'document', text: 'A newsletter item about the Vantrix Series K notes describes the contingent coupon as "about 2 and a quarter percent a quarter".' },

    { id: 'cf-scanner-claim', source: 'document', text: 'An automated dependency scanner flags Kestrel Runtime 3.4.1 as vulnerable to CVE-2026-2211 based on version-range matching alone.' },
    { id: 'cf-kestrel-vendor', source: 'document', text: 'Kestrel Runtime maintainers state that 3.4.1 backported the fix for CVE-2026-2211 and is not vulnerable, though the version string was not bumped.' },

    { id: 'cf-transcript', source: 'document', text: 'Official transcript of the Merrowfield Systems investor day: the chief executive says the Brightwater expansion will complete "in the second half of next year".' },
    { id: 'cf-journalist', source: 'document', text: 'A conference write-up reports that Merrowfield executives promised the Brightwater expansion would be finished by the first quarter of next year.' },

    { id: 'cf-onchain', source: 'document', text: 'The Corvid staking contract at 0x7c19 returns a totalStaked value of 48,215 SOLT when read directly from the chain.' },
    { id: 'cf-dashboard', source: 'document', text: 'A community analytics dashboard displays Corvid total staked as 51,900 SOLT. Its footer notes that values are cached and refreshed roughly daily.' },

    { id: 'cf-statute', source: 'document', text: 'Section 12 of the Ellerby Reporting Act requires disclosure within thirty calendar days of the triggering event.' },
    { id: 'cf-clientalert', source: 'document', text: 'A law firm client alert summarising the Ellerby Reporting Act says firms have "about a month, or roughly twenty business days" to disclose.' },

    /* --- specificity: the narrower rule governs ---------------------------- */
    { id: 'cf-general-limit', source: 'document', text: 'Alderin platform policy: all API endpoints are limited to 250 requests per minute.' },
    { id: 'cf-specific-limit', source: 'document', text: 'Alderin bulk export endpoint documentation: notwithstanding the platform-wide limit, the bulk export endpoint accepts 10 requests per minute.' },

    { id: 'cf-chain-general', source: 'document', text: 'The Corvid chain imposes no protocol-level cap on the block range accepted by log queries.' },
    { id: 'cf-provider-specific', source: 'document', text: 'The Corvid free-tier RPC provider caps eth_getLogs at a 10,000 block range per request and returns an error beyond it.' },

    { id: 'cf-pop-general', source: 'document', text: 'Halbrook Clinical Standard: the Prentiss index referral threshold is 130 for the general adult population.' },
    { id: 'cf-pop-subgroup', source: 'document', text: 'Halbrook Clinical Standard, subgroup appendix: for adults with documented Farrow syndrome the Prentiss referral threshold is 115, which takes precedence over the general threshold for that group.' },

    { id: 'cf-policy-company', source: 'document', text: 'Merrowfield Systems group travel policy requires all bookings to be made through the central agency.' },
    { id: 'cf-policy-sub', source: 'document', text: 'The Merrowfield Marine subsidiary operates under an approved carve-out permitting direct booking for offshore crew rotations, which the group policy expressly allows.' },

    { id: 'cf-decimals-default', source: 'document', text: 'Most tokens on the Corvid chain use 18 decimals, and 18 is the conventional default when decoding balances.' },
    { id: 'cf-decimals-token', source: 'document', text: 'The SOLT token contract reports 6 decimals, so decoding a SOLT balance with the 18-decimal default understates it by a factor of one trillion.' },

    /* --- correction: explicit erratum, retraction, withdrawal --------------- */
    { id: 'cf-note-first', source: 'document', text: 'Research note dated 8 April 2026 puts the Brightwater project cost at 1.9 billion.' },
    { id: 'cf-note-correction', source: 'document', text: 'Correction issued 10 April 2026: our note of 8 April misstated the Brightwater project cost. The correct figure is 2.4 billion. We regret the error.' },

    { id: 'cf-claim-retracted', source: 'document', text: 'An earlier bulletin reported that Merrowfield Systems had signed a supply agreement with Ostrand Metals.' },
    { id: 'cf-retraction', source: 'document', text: 'Retraction: the bulletin reporting a Merrowfield and Ostrand Metals supply agreement was withdrawn in full on 2 June 2026. No such agreement was signed and the report should not be relied upon.' },

    { id: 'cf-spec-errata-base', source: 'document', text: 'Coldharbour Protocol specification section 4 gives the frame header length as 12 bytes.' },
    { id: 'cf-spec-errata', source: 'document', text: 'Coldharbour errata sheet ERR-3: section 4 is corrected — the frame header length is 16 bytes, not 12. Implementations following the uncorrected text will misparse every frame.' },

    { id: 'cf-cve-listed', source: 'document', text: 'CVE-2026-3390 was published describing a privilege escalation in Kestrel Runtime.' },
    { id: 'cf-cve-rejected', source: 'document', text: 'CVE-2026-3390 has been marked REJECTED by the assigning authority. The report was a duplicate of CVE-2026-3102 and the identifier should not be cited as a distinct vulnerability.' },

    { id: 'cf-guidance-given', source: 'document', text: 'Merrowfield Systems guided to full-year 2026 revenue of 450 million at its first-quarter briefing.' },
    { id: 'cf-guidance-withdrawn', source: 'document', text: 'Merrowfield Systems withdrew its full-year 2026 revenue guidance on 14 July 2026, citing an unresolved contract dispute, and has not issued a replacement figure.' },

    /* --- unresolvable: no winner; reporting the conflict is the answer ------ */
    { id: 'cf-dual-a', source: 'document', text: 'Ellerby regulatory filing R-88, dated 9 May 2026, gives the Brightwater installed capacity as 640 megawatts.' },
    { id: 'cf-dual-b', source: 'document', text: 'Ellerby regulatory filing R-91, also dated 9 May 2026 and filed by the same operator, gives the Brightwater installed capacity as 680 megawatts. Neither filing references or amends the other.' },

    { id: 'cf-undated-a', source: 'document', text: 'An internal Merrowfield engineering note, undated, records the Coldharbour retry budget as 5 attempts.' },
    { id: 'cf-undated-b', source: 'document', text: 'A second internal Merrowfield engineering note, also undated, records the Coldharbour retry budget as 3 attempts. There is no indication which note is later.' },

    { id: 'cf-reg-one', source: 'document', text: 'The Ellerby financial authority sets the minimum disclosure threshold for cross-border transfers at 10,000.' },
    { id: 'cf-reg-two', source: 'document', text: 'The Ellerby markets authority, whose remit overlaps for cross-border transfers, sets the minimum disclosure threshold at 15,000. The two authorities have not reconciled their thresholds.' },

    { id: 'cf-nodate-new', source: 'document', text: 'A Vantrix investor page states the Series K coupon as 2.5 percent. The page carries no date and no version.' },
    { id: 'cf-dated-old', source: 'document', text: 'The Vantrix Series K pricing supplement dated 4 March 2026 states the coupon as 2.0625 percent. It is unknown whether the undated investor page predates or postdates it.' },

    { id: 'cf-mirror-a', source: 'document', text: 'One mirror of the Corvid genesis parameters lists the initial validator set size as 64.' },
    { id: 'cf-mirror-b', source: 'document', text: 'Another mirror of the Corvid genesis parameters lists the initial validator set size as 96. Both mirrors are unsigned and neither can be traced to the original publisher.' },
];

/**
 * Answer-level acknowledgement that the evidence does not settle the question.
 *
 * Every pattern here describes something the RESPONDER does — states its own
 * inability, or characterises the sources as a set that disagrees. None can be
 * produced by echoing a document, because a document describes its own subject
 * and provenance, not the responder's epistemic position. That property is
 * asserted by the lint, not assumed: no pattern below may match any of the 62
 * conflict documents.
 *
 * Deliberately does NOT accept bare "conflict", "differ", "both" or "neither".
 * Those were the A2 defect.
 */
const UNRESOLVED_ACK = [
    // first-person inability
    /\b(?:i|we)\s+(?:can(?:no|')?t|cannot|am unable|are unable|have no way)\b/i,
    // the sources, characterised as a disagreeing set
    /\b(?:sources?|documents?|filings?|notes?|records?|figures?|versions?|reports?|accounts?)\b[^.]{0,60}\b(?:conflict|disagree|contradict each other|do not agree|don'?t agree|are inconsistent)\b/i,
    /\bconflicting\s+(?:sources?|documents?|filings?|figures?|values?|numbers?|reports?|information|evidence|accounts?)\b/i,
    // explicit non-determination
    /\bcannot\s+be\s+(?:determined|resolved|established|reconciled)\b/i,
    /\bno\s+way\s+to\s+(?:tell|determine|know|establish)\b/i,
    /\bthere\s+is\s+(?:a|an)\s+(?:conflict|disagreement|discrepancy|inconsistency)\b/i,
    /\bwithout\s+(?:further|additional|more)\s+(?:evidence|information|context)\b/i,
];

/**
 * `type` records which precedence relation the item is meant to exercise. It is
 * reported alongside `kind` so a resolver can be scored per relation — an engine
 * that wins on supersession and loses on recency-trap is a date sort, and the
 * aggregate would hide that.
 */
export const CONFLICT_QUESTIONS = [
    /* --- supersession (5) -------------------------------------------------- */
    {
        id: 'k-sup-principal', kind: 'conflict', type: 'supersession', doc: 'cf-note-amend',
        q: 'what is the aggregate principal amount of the vantrix series k notes',
        must: [/14[,.]?900[,.]?000|14\.9\s*(?:million|m\b)/i],
    },
    {
        id: 'k-sup-threshold', kind: 'conflict', type: 'supersession', doc: 'cf-guide-new',
        q: 'what is the current prentiss index referral threshold in the halbrook standard',
        must: [/\b130\b/],
    },
    {
        id: 'k-sup-settled', kind: 'conflict', type: 'supersession', doc: 'cf-tx-confirmed',
        q: 'how much solt did transaction 0xa41f actually transfer',
        must: [/\b3\.0\b|\bthree\b|\b3 solt\b/i],
    },
    {
        id: 'k-sup-headcount', kind: 'conflict', type: 'supersession', doc: 'cf-headcount-q3',
        q: 'how many full time employees does merrowfield systems have',
        must: [/1[,.]?050|1050/],
    },
    {
        id: 'k-sup-ratelimit', kind: 'conflict', type: 'supersession', doc: 'cf-ratelimit-v2',
        q: 'what is the alderin authenticated endpoint rate limit',
        must: [/\b250\b/],
    },

    /* --- recency trap: newer must NOT win (6) ------------------------------- */
    {
        id: 'k-trap-primary', kind: 'conflict', type: 'recency-trap', doc: 'cf-primary-filing',
        q: 'what was the size of the vantrix series m offering',
        must: [/17[,.]?320[,.]?000|17\.32\s*(?:million|m\b)/i],
    },
    {
        id: 'k-trap-draft', kind: 'conflict', type: 'recency-trap', doc: 'cf-spec-final',
        q: 'what handshake timeout should a coldharbour implementation use',
        must: [/\b30\b\s*(?:second|sec|s\b)|thirty second/i],
    },
    {
        id: 'k-trap-advisory', kind: 'conflict', type: 'recency-trap', doc: 'cf-vendor-advisory',
        q: 'is nyxsoft 5.2.3 affected by the deserialisation issue',
        must: [/not affected|unaffected|\bno\b|only 5\.1/i],
    },
    {
        id: 'k-trap-audited', kind: 'conflict', type: 'recency-trap', doc: 'cf-audited',
        q: 'what was merrowfield systems full year 2025 revenue',
        must: [/412\.6|412 point six/i],
    },
    {
        id: 'k-trap-syndicated', kind: 'conflict', type: 'recency-trap', doc: 'cf-vendor-current',
        q: 'what is the alderin storage tier ceiling',
        must: [/\b8\b\s*(?:terabyte|tb)|eight terabyte/i],
    },
    {
        id: 'k-trap-paraphrase', kind: 'conflict', type: 'recency-trap', doc: 'cf-tenk',
        q: 'what is the installed capacity of the brightwater facility',
        must: [/\b640\b/],
    },

    /* --- authority: primary over secondary (5) ------------------------------ */
    {
        id: 'k-auth-coupon', kind: 'conflict', type: 'authority', doc: 'cf-coupon-filing',
        q: 'what is the contingent coupon rate on the vantrix series k notes',
        must: [/2\.0625/],
    },
    {
        id: 'k-auth-kestrel', kind: 'conflict', type: 'authority', doc: 'cf-kestrel-vendor',
        q: 'is kestrel runtime 3.4.1 vulnerable to cve-2026-2211',
        must: [/not vulnerable|backport|\bno\b|fixed/i],
    },
    {
        id: 'k-auth-timeline', kind: 'conflict', type: 'authority', doc: 'cf-transcript',
        q: 'when did merrowfield say the brightwater expansion would complete',
        must: [/second half/i],
    },
    {
        id: 'k-auth-staked', kind: 'conflict', type: 'authority', doc: 'cf-onchain',
        q: 'how much solt is staked in the corvid staking contract',
        must: [/48[,.]?215/],
    },
    {
        id: 'k-auth-deadline', kind: 'conflict', type: 'authority', doc: 'cf-statute',
        q: 'how long do firms have to disclose under section 12 of the ellerby reporting act',
        must: [/thirty|\b30\b/i],
    },

    /* --- specificity: narrow over general (5) ------------------------------- */
    {
        id: 'k-spec-bulk', kind: 'conflict', type: 'specificity', doc: 'cf-specific-limit',
        q: 'what rate limit applies to the alderin bulk export endpoint',
        must: [/\b10\b\s*(?:requests?|per|\/)|\bten\b/i],
    },
    {
        id: 'k-spec-getlogs', kind: 'conflict', type: 'specificity', doc: 'cf-provider-specific',
        q: 'how many blocks can I request at once from eth_getlogs on the corvid free tier',
        must: [/10[,.]?000|ten thousand/i],
    },
    {
        id: 'k-spec-subgroup', kind: 'conflict', type: 'specificity', doc: 'cf-pop-subgroup',
        q: 'what prentiss threshold applies to an adult with documented farrow syndrome',
        must: [/\b115\b/],
    },
    {
        id: 'k-spec-carveout', kind: 'conflict', type: 'specificity', doc: 'cf-policy-sub',
        q: 'can merrowfield marine book offshore crew rotations directly',
        must: [/\byes\b|carve[- ]?out|permitt?ed|may book|allowed/i],
    },
    {
        id: 'k-spec-decimals', kind: 'conflict', type: 'specificity', doc: 'cf-decimals-token',
        q: 'how many decimals should I use to decode a solt balance',
        must: [/\bsix\b|\b6\b/i],
    },

    /* --- correction: erratum, retraction, withdrawal (5) -------------------- */
    {
        id: 'k-corr-cost', kind: 'conflict', type: 'correction', doc: 'cf-note-correction',
        q: 'what is the brightwater project cost',
        must: [/2\.4\s*(?:billion|bn|b\b)|2[,.]?400/i],
    },
    {
        // The retracted claim must not be repeated as fact — this is one of the
        // few places a trap is right, because ANY assertion of the agreement is
        // the failure regardless of what else the answer says.
        id: 'k-corr-retracted', kind: 'conflict', type: 'correction', doc: 'cf-retraction',
        q: 'did merrowfield sign a supply agreement with ostrand metals',
        must: [/retract|withdraw|no such agreement|\bno\b|not signed/i],
        trap: [/\b(?:yes|they did|signed a supply agreement|merrowfield signed)\b/i],
    },
    {
        id: 'k-corr-errata', kind: 'conflict', type: 'correction', doc: 'cf-spec-errata',
        q: 'what is the coldharbour frame header length',
        must: [/\b16\b\s*byte|sixteen byte/i],
    },
    {
        id: 'k-corr-cve', kind: 'conflict', type: 'correction', doc: 'cf-cve-rejected',
        q: 'should I track cve-2026-3390 as a distinct vulnerability',
        must: [/reject|duplicate|\bno\b|3102/i],
        trap: [/\byes\b.{0,40}(?:distinct|separate|track it)/i],
    },
    {
        id: 'k-corr-guidance', kind: 'conflict', type: 'correction', doc: 'cf-guidance-withdrawn',
        q: 'what is merrowfield guiding to for full year 2026 revenue',
        // "withdrew", not "withdraw" — the corpus lint caught this one, which is
        // the whole argument for having a lint: the item was unpassable and
        // would have shown up as a resolver failure rather than a typo.
        must: [/withdrew|withdrawn|withdraw|no (?:current |replacement )?guidance|rescind|no longer|not issued a replacement/i],
        trap: [/\b450\b\s*million|guiding to 450/i],
    },

    /* --- unresolvable: reporting the conflict IS the answer (5) -------------
       No traps. A correct answer names both figures while refusing to pick, so
       a trap on either one would fire on the best possible response. `must`
       requires the acknowledgement, which an answer that silently picks a side
       cannot satisfy.

       DEFECT A2, found by the naive baselines on 22 Jul 2026 and fixed here.
       The original patterns matched bare words — conflict|differ|both|neither|
       not reconcil|which is later — all of which appear IN THE DOCUMENTS:
       "Neither filing references or amends the other", "There is no indication
       which note is later", "have not reconciled their thresholds", "Both
       mirrors are unsigned and neither can be traced". Emitting a document
       verbatim therefore PASSED. always-longest scored 4/5 on this relation by
       copying, and a model could pass without reasoning at all.

       The fix is to the MATCHER only — no document text and no gold behaviour
       changed. The required language is now answer-level: a statement the
       responder makes about its own inability or about the sources as a set.
       A document describing its own provenance cannot produce it. The lint
       asserts that no unresolvable `must` matches ANY conflict document. */
    {
        id: 'k-unres-capacity', kind: 'conflict', type: 'unresolvable', doc: 'cf-dual-a',
        q: 'what is the brightwater installed capacity according to the ellerby filings',
        must: UNRESOLVED_ACK,
    },
    {
        id: 'k-unres-retry', kind: 'conflict', type: 'unresolvable', doc: 'cf-undated-a',
        q: 'what is the coldharbour retry budget',
        must: UNRESOLVED_ACK,
    },
    {
        id: 'k-unres-threshold', kind: 'conflict', type: 'unresolvable', doc: 'cf-reg-one',
        q: 'what is the ellerby minimum disclosure threshold for cross border transfers',
        must: UNRESOLVED_ACK,
    },
    {
        id: 'k-unres-coupon', kind: 'conflict', type: 'unresolvable', doc: 'cf-nodate-new',
        q: 'is the vantrix series k coupon 2.5 percent or 2.0625 percent',
        must: UNRESOLVED_ACK,
    },
    {
        id: 'k-unres-validators', kind: 'conflict', type: 'unresolvable', doc: 'cf-mirror-a',
        q: 'what was the corvid initial validator set size',
        must: UNRESOLVED_ACK,
    },
];

/**
 * MINIMAL REQUIRED EVIDENCE — [governing, opposing] for every question.
 *
 * Conflict resolution is two stages and they fail for different reasons:
 *
 *     retrieve BOTH sides  ->  decide which governs
 *
 * If recall surfaces only one document there is no conflict to resolve, and the
 * model answering from it is not making an error of judgement — it is answering
 * the question it was actually shown. Scoring that as a resolver failure would
 * send every fix to the wrong subsystem. With this map the harness can separate:
 *
 *     conflict retrieval recall     were both halves retrieved?
 *     conflict resolution accuracy  given both, was the right one chosen?
 *     end-to-end accuracy           the product, which is what a user sees
 *
 * Kept as an explicit map rather than derived from document ordering, because a
 * derivation would silently produce wrong pairs the first time a document is
 * inserted in the middle, and the lint would have nothing to check it against.
 */
export const CONFLICT_PAIRS = {
    // supersession
    'k-sup-principal': ['cf-note-amend', 'cf-note-orig'],
    'k-sup-threshold': ['cf-guide-new', 'cf-guide-old'],
    'k-sup-settled': ['cf-tx-confirmed', 'cf-tx-pending'],
    'k-sup-headcount': ['cf-headcount-q3', 'cf-headcount-q1'],
    'k-sup-ratelimit': ['cf-ratelimit-v2', 'cf-ratelimit-v1'],
    // recency-trap — governing document is the OLDER one
    'k-trap-primary': ['cf-primary-filing', 'cf-later-blog'],
    'k-trap-draft': ['cf-spec-final', 'cf-spec-draft'],
    'k-trap-advisory': ['cf-vendor-advisory', 'cf-aggregator-late'],
    'k-trap-audited': ['cf-audited', 'cf-prelim-later'],
    'k-trap-syndicated': ['cf-vendor-current', 'cf-syndicated'],
    'k-trap-paraphrase': ['cf-tenk', 'cf-call-paraphrase'],
    // authority
    'k-auth-coupon': ['cf-coupon-filing', 'cf-coupon-news'],
    'k-auth-kestrel': ['cf-kestrel-vendor', 'cf-scanner-claim'],
    'k-auth-timeline': ['cf-transcript', 'cf-journalist'],
    'k-auth-staked': ['cf-onchain', 'cf-dashboard'],
    'k-auth-deadline': ['cf-statute', 'cf-clientalert'],
    // specificity
    'k-spec-bulk': ['cf-specific-limit', 'cf-general-limit'],
    'k-spec-getlogs': ['cf-provider-specific', 'cf-chain-general'],
    'k-spec-subgroup': ['cf-pop-subgroup', 'cf-pop-general'],
    'k-spec-carveout': ['cf-policy-sub', 'cf-policy-company'],
    'k-spec-decimals': ['cf-decimals-token', 'cf-decimals-default'],
    // correction
    'k-corr-cost': ['cf-note-correction', 'cf-note-first'],
    'k-corr-retracted': ['cf-retraction', 'cf-claim-retracted'],
    'k-corr-errata': ['cf-spec-errata', 'cf-spec-errata-base'],
    'k-corr-cve': ['cf-cve-rejected', 'cf-cve-listed'],
    'k-corr-guidance': ['cf-guidance-withdrawn', 'cf-guidance-given'],
    /* unresolvable — the pair is symmetric and neither governs. The first slot
       is named only so the shape stays uniform; nothing may prefer it. */
    'k-unres-capacity': ['cf-dual-a', 'cf-dual-b'],
    'k-unres-retry': ['cf-undated-a', 'cf-undated-b'],
    'k-unres-threshold': ['cf-reg-one', 'cf-reg-two'],
    // Slot order follows the question's `doc` for uniformity; for unresolvable
    // items "governing" names nothing, and no resolver may prefer it.
    'k-unres-coupon': ['cf-nodate-new', 'cf-dated-old'],
    'k-unres-validators': ['cf-mirror-a', 'cf-mirror-b'],
};

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A probe that distinguishes a document from its own twin BY CONSTRUCTION.
 *
 * The obvious implementation — a slice from a fixed offset — does not work here,
 * and the corpus lint caught it. The two halves of a conflict are deliberately
 * near-identical: same subject, same phrasing, one differing value. A positional
 * slice lands in the shared wording and matches the twin, so the harness would
 * report both halves retrieved whenever either one was.
 *
 * So the probe starts where the two texts DIVERGE. Everything before that point
 * is shared by definition and carries no discriminating power; everything from
 * it onward is what makes this document the one it is.
 */
function discriminatingProbe(text, twin, len = 45) {
    const a = norm(text), b = norm(twin);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    // Back up to a word boundary so the probe does not start mid-token.
    while (i > 0 && !/\s/.test(a[i - 1])) i--;
    // Near the end there may be less than `len` left; take the last window.
    const start = Math.min(i, Math.max(0, a.length - len));
    return a.slice(start, start + len);
}

/**
 * Was each side of the conflict actually placed in front of the model?
 *
 * Matched on document TEXT, not id: the id never reaches the prompt, because
 * retrieval context carries chunk text. Returning `governing` and `opposing`
 * separately is the point — it distinguishes "the model was never shown the
 * conflict" from "the model was shown it and chose wrong".
 */
export function evidenceRetrieved(questionId, contextText) {
    const pair = CONFLICT_PAIRS[questionId];
    if (!pair) return null;
    const ctx = norm(contextText);
    const byId = Object.fromEntries(CONFLICT_DOCS.map((d) => [d.id, d.text]));
    const [govId, oppId] = pair;
    const seen = [[govId, oppId], [oppId, govId]].map(([id, twinId]) => {
        const t = byId[id];
        if (!t) return false;
        const probe = discriminatingProbe(t, byId[twinId] || '');
        return probe.length >= 20 && ctx.includes(probe);
    });
    return { governing: seen[0], opposing: seen[1], both: seen[0] && seen[1] };
}

export function describeConflictCorpus(qs = CONFLICT_QUESTIONS) {
    const byType = {};
    for (const q of qs) byType[q.type] = (byType[q.type] || 0) + 1;
    return { total: qs.length, byType, docs: CONFLICT_DOCS.length };
}
