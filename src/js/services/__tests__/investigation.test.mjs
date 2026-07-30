// Investigation pipeline: planning, document extraction, evidence accounting.
//
// The fixtures are cut from the REAL Goldman Sachs 424B2 that the model
// fabricated a compensation structure about on 22 Jul 2026 — the filing at
// /Archives/edgar/data/886982/000119312526310059/gs-20260721.htm, fetched in
// 0.68s, 354KB of HTML, 76,076 characters of text. The point of every check
// below is that the answer comes from that text and not from the model.

import {
    planInvestigation, extractDocumentText, pickPrimaryDocument,
    buildLedger, describeLedger, renderEvidence, buildSynthesisPrompt,
    verifyEntityAttribution, describeAttributionMismatch, normaliseEntity,
    parseDateHint, parseTemporalScope, applyTemporalGate, describeFreshness,
    EVIDENCE_BUDGET_CHARS,
} from '../investigation.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

/* Trimmed from the real body, including the table markup that carries the
   numbers and the inline styling EDGAR emits. */
const REAL_HTML = `<html><head><style>.x{font:9pt}</style></head><body>
<div style="font-size:9pt">424B2 1 gs-20260721.htm 424B2</div>
<p>July 2026 Pricing Supplement filed pursuant to Rule 424(b)(2) dated July 17, 2026</p>
<p>STRUCTURED INVESTMENTS Opportunities in U.S. Equities</p>
<p>GS Finance Corp. <b>$17,320,000</b> Contingent Income Auto-Callable Securities Based on the
Performance of the Common Stock of NVIDIA Corporation due July 20, 2029</p>
<table><tr><td>Contingent coupon</td><td>2.0625%</td></tr><tr><td>Downside threshold</td><td>50%</td></tr></table>
<script>var x=1;</script></body></html>`;

/* --- document extraction ------------------------------------------------------ */
{
    const text = extractDocumentText(REAL_HTML);
    check('extract: the real amount survives', /\$17,320,000/.test(text), text.slice(0, 80));
    check('extract: the underlying is preserved', /NVIDIA Corporation/.test(text));
    check('extract: the form type is preserved', /424B2/.test(text));
    check('extract: script and style contents are gone', !/font:9pt|var x=1/.test(text), text.slice(0, 120));
    check('extract: no markup survives', !/[<>]/.test(text));

    /* THE BOUNDARY BUG THIS GUARDS. Without a separator on cell close, the two
       table values run together as "2.0625%50%" — a number that appears in no
       document and would then be quoted as fact. */
    check('extract: adjacent table cells do not fuse into a fake number',
        /2\.0625%/.test(text) && /50%/.test(text) && !/2\.0625%50%/.test(text), text.slice(-90));

    check('extract: empty input is empty, not a throw', extractDocumentText('') === '' && extractDocumentText(null) === '');
    check('extract: honours a character ceiling', extractDocumentText(REAL_HTML, { maxChars: 40 }).length === 40);
}

/* --- inline XBRL scaffolding ------------------------------------------------
   Measured on Alphabet's real 10-Q (goog-20260630.htm, 23 Jul 2026): the
   <ix:header> block is 281,415 bytes, which is LARGER than this function's
   whole 200,000-character budget. Before it was stripped, prose began 49,963
   characters in, "Total revenues" landed at 84,614, the condensed consolidated
   statements never made the cut at all, and 641 XBRL URI tokens survived into
   the text handed to a 4B model. The fixture below is that shape in miniature. */
{
    const IXBRL = `<html><body>
<ix:header><ix:hidden><ix:nonNumeric name="dei:EntityRegistrantName">Alphabet Inc.</ix:nonNumeric></ix:hidden>
<ix:references><link:schemaRef xlink:href="goog-20260630.xsd"/></ix:references>
<ix:resources>
<xbrli:context id="c-1"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001652044</xbrli:identifier></xbrli:entity></xbrli:context>
<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
http://fasb.org/us-gaap/2026#Revenues http://fasb.org/us-gaap/2026#NonoperatingIncomeExpense
http://fasb.org/us-gaap/2026#Revenues http://fasb.org/us-gaap/2026#OtherAssetsCurrent
</ix:resources></ix:header>
<p>UNITED STATES SECURITIES AND EXCHANGE COMMISSION FORM 10-Q</p>
<table><tr><td>Total revenues</td><td>$</td><td>119,800</td></tr></table>
</body></html>`;

    const t = extractDocumentText(IXBRL);

    check('ixbrl: the taxonomy URI storm is gone', !/fasb\.org/.test(t), t.slice(0, 120));
    check('ixbrl: unit and context scaffolding is gone', !/iso4217|xbrli:|schemaRef/.test(t), t.slice(0, 120));
    /* The document must now START at the document. */
    check('ixbrl: prose is at the front, not 50k chars in', t.indexOf('UNITED STATES') < 40,
        `at ${t.indexOf('UNITED STATES')}: ${t.slice(0, 80)}`);
    check('ixbrl: the financial figure still survives', /119,800/.test(t) && /Total revenues/.test(t), t);
    /* Only the two containers go. An inline ix: tag WRAPPING a real value is
       part of the filing and its text must be kept — stripping those would
       delete every tagged number in the document. */
    check('ixbrl: an inline ix: tag around a real value keeps its text', (() => {
        const wrapped = '<p>Revenue was <ix:nonFraction unitRef="usd" scale="6">119800</ix:nonFraction> million.</p>';
        return /119800/.test(extractDocumentText(wrapped));
    })(), extractDocumentText('<p>Revenue was <ix:nonFraction unitRef="usd" scale="6">119800</ix:nonFraction> million.</p>'));
    check('ixbrl: a document with no ix: blocks is unchanged',
        extractDocumentText(REAL_HTML).includes('STRUCTURED INVESTMENTS'));
}

/* --- primary document selection ------------------------------------------------ */
{
    /* The real index.json listing shape: the filing, the complete-submission
       text file, and the index headers. Only the first is the document. */
    const items = [
        { name: '0001193125-26-310059-index-headers.html', size: '11056' },
        { name: '0001193125-26-310059-index.htm', size: '11056' },
        { name: 'gs-20260721.htm', size: '354829' },
        { name: 'exhibit-cert.htm', size: '2100' },
    ];
    check('primary: picks the filing, not the index', pickPrimaryDocument(items) === 'gs-20260721.htm', String(pickPrimaryDocument(items)));
    check('primary: an exhibit does not win on name alone',
        pickPrimaryDocument([{ name: 'exhibit-cert.htm', size: '2100' }, { name: 'gs-20260721.htm', size: '354829' }]) === 'gs-20260721.htm');
    check('primary: nothing usable yields null', pickPrimaryDocument([{ name: 'a.txt', size: '10' }]) === null);
    check('primary: junk input yields null, not a throw', pickPrimaryDocument(null) === null);
}

/* --- planning -------------------------------------------------------------------- */
{
    const p = planInvestigation('investigate the goldman sachs 424B2 filing');
    check('plan: a filing question reads the document', p.steps.includes('document'), JSON.stringify(p.steps));
    check('plan: and searches full text', p.steps.includes('search'));
    check('plan: memory is always consulted first', p.steps[0] === 'memory');
    check('plan: the form type is carried', p.forms.includes('424B2'), JSON.stringify(p.forms));
    check('plan: an empty question plans nothing', planInvestigation('  ') === null);
}

/* --- ledger ---------------------------------------------------------------------- */
{
    const ledger = buildLedger([
        { kind: 'feed', text: 'GOLDMAN SACHS GROUP INC (0000886982) (Filer). 424B2', published: '2026-07-21', url: 'https://www.sec.gov/x' },
        { kind: 'document', text: extractDocumentText(REAL_HTML), url: 'https://www.sec.gov/y' },
        { kind: 'web', text: 'Goldman Sachs is a global investment bank.', url: 'https://example.com' },
        // duplicate of the feed line, arriving from search
        { kind: 'search', text: 'GOLDMAN SACHS GROUP INC (0000886982) (Filer). 424B2' },
        { kind: 'nonsense', text: 'should be dropped' },
        { kind: 'web', text: 'x' },
    ]);

    check('ledger: the fetched document ranks above the headline about it',
        ledger[0].kind === 'document', ledger.map(e => e.kind).join(','));
    check('ledger: the same text from two sources counts once',
        ledger.filter(e => /GOLDMAN SACHS GROUP INC/.test(e.text)).length === 1);
    check('ledger: an unknown kind is not evidence', !ledger.some(e => e.kind === 'nonsense'));
    check('ledger: a fragment too short to check is not evidence', !ledger.some(e => e.text === 'x'));

    const d = describeLedger(ledger);
    check('ledger: reports whether a primary document was actually read', d.hasPrimary === true);
    check('ledger: a ledger with no document says so',
        describeLedger(buildLedger([{ kind: 'web', text: 'some snippet about a company' }])).hasPrimary === false);
}

/* --- rendering and the synthesis prompt ------------------------------------------ */
{
    const ledger = buildLedger([
        { kind: 'document', text: extractDocumentText(REAL_HTML), url: 'https://www.sec.gov/y', published: '2026-07-21' },
        { kind: 'feed', text: 'GOLDMAN SACHS GROUP INC (0000886982) (Filer). 424B2', published: '2026-07-21' },
    ]);

    const rendered = renderEvidence(ledger);
    check('render: evidence is numbered for citation', /^\[1\]/.test(rendered), rendered.slice(0, 60));
    check('render: the source kind is stated', /primary document/.test(rendered));
    check('render: the url is carried so a human can check it', /https:\/\/www\.sec\.gov\/y/.test(rendered));
    check('render: stays inside the budget',
        renderEvidence(ledger, { budget: 800 }).length <= 800, `${renderEvidence(ledger, { budget: 800 }).length}`);

    const prompt = buildSynthesisPrompt('what is this filing about', ledger);
    check('prompt: carries the question', /what is this filing about/.test(prompt));
    check('prompt: carries the real amount from the document', /\$17,320,000/.test(prompt));
    check('prompt: demands citation', /\[n\]/.test(prompt));
    check('prompt: instructs what to do when evidence is missing', /does not answer the question/.test(prompt));
    /* The offer-then-fabricate loop from the log started with an offer. */
    check('prompt: forbids offering to retrieve more', /Do not offer to retrieve/.test(prompt));

    /* THE CONTRACT. No evidence means no model call at all — the state the
       assistant was in when it invented eight turns of compensation data. */
    check('prompt: no evidence means no prompt, so no answer', buildSynthesisPrompt('anything', []) === null);
    check('prompt: unusable evidence also yields nothing',
        buildSynthesisPrompt('anything', buildLedger([{ kind: 'web', text: 'x' }])) === null);
}


/* --- entity-attribution verification (deceptive grounding) --------------------
   arXiv 2607.09349, Caruzzo et al., Jul 2026. NOT taken on faith: reproduced on
   this machine with two real 424B2 filings. Given ONLY the Morgan Stanley
   document and asked about Goldman Sachs, gemma3:4b reported Morgan Stanley's
   $700,000 aggregate principal and $950.40 estimated value as Goldman's — and
   the money guard PASSED it, correctly by its own rule, because every figure
   was genuinely in the evidence. Figure-presence is not entity-ownership. */
{
    const msLedger = buildLedger([{ kind: 'document', text: 'Pricing supplement no. 17,393. Aggregate principal amount $700,000. Estimated value $950.40 per security.', entity: 'MORGAN STANLEY', url: 'https://www.sec.gov/x' }]);

    const bad = verifyEntityAttribution('what is the Goldman Sachs filing about and what are its key numbers', msLedger);
    check('eav: the reproduced failure is caught', bad.applies && !bad.ok, JSON.stringify(bad));
    check('eav: the refusal names what the evidence IS about',
        /morgan stanley/i.test(describeAttributionMismatch('the goldman sachs filing', bad)));
    check('eav: the refusal admits the figures are real',
        /every number in it is real/.test(describeAttributionMismatch('x', bad)));

    /* Must NOT fire when the evidence really is about the queried entity, or it
       is a check nobody keeps. */
    const gsLedger = buildLedger([{ kind: 'document', text: 'GS Finance Corp. $17,320,000 contingent income auto-callable securities.', entity: 'GOLDMAN SACHS GROUP INC' }]);
    check('eav: passes when the evidence is about the queried entity',
        verifyEntityAttribution('what is the goldman sachs filing about', gsLedger).ok);
    check('eav: corporate suffixes do not cause a false mismatch',
        verifyEntityAttribution('the Goldman Sachs Group, Inc. filing', gsLedger).ok);
    check('eav: lowercase speech input still matches',
        verifyEntityAttribution('tell me about the goldman sachs filing', gsLedger).ok);

    /* A question that names no entity cannot mis-attribute one. */
    check('eav: an entity-free question is not gated',
        verifyEntityAttribution('what are the key numbers', gsLedger).ok);
    check('eav: does not apply when no evidence carries an entity',
        verifyEntityAttribution('goldman sachs', buildLedger([{ kind: 'web', text: 'some snippet with no named filer' }])).applies === false);

    check('eav: normalisation strips corporate suffixes',
        normaliseEntity('The Goldman Sachs Group, Inc.') === normaliseEntity('GOLDMAN SACHS GROUP INC'));
    check('eav: two different filers do not normalise together',
        normaliseEntity('MORGAN STANLEY') !== normaliseEntity('GOLDMAN SACHS GROUP INC'));
}

/* --- temporal validity ----------------------------------------------------
   WorldReasoner (arXiv 2606.11816) measured temporally valid retrieval as the
   strongest driver of outcome accuracy: 68.8% with it vs 58.7% without, 74.7%
   with the boundary moved to one day before resolution. The same table is why
   there is no causal-graph simulator here — Causal Simulation scored 56.6%,
   below the no-retrieval baseline, and graphs cost search-enabled agents 4.4pp.

   Dates below are the real ones: the Goldman 424B2 priced 17 Jul 2026 and was
   filed 21 Jul 2026. */
{
    check('temporal: ISO date parses', parseDateHint('as of 2026-07-17').toISOString().startsWith('2026-07-17'));
    check('temporal: "July 17, 2026" parses', parseDateHint('as of July 17, 2026').toISOString().startsWith('2026-07-17'));
    check('temporal: "17 July 2026" parses', parseDateHint('before 17 July 2026').toISOString().startsWith('2026-07-17'));
    check('temporal: prose without a date yields null, not a wrong date', parseDateHint('some time last quarter') === null);

    check('temporal: an as-of boundary is recognised', parseTemporalScope('what was known as of July 17, 2026').kind === 'as-of');
    check('temporal: "before <date>" is a boundary', parseTemporalScope('what filings existed before 2026-07-20').kind === 'as-of');
    check('temporal: "latest" is a currency demand', parseTemporalScope('what is the latest goldman filing').kind === 'current');
    check('temporal: a plain question is ungated', parseTemporalScope('what is a 424B2').kind === 'none');

    /* THE TRAP. A date in the question is not a horizon. "the July 2026
       prospectus" names its subject; gating on it would discard the filing. */
    check('temporal: a date naming the subject is not a boundary',
        parseTemporalScope('summarise the July 17, 2026 prospectus').kind !== 'as-of',
        JSON.stringify(parseTemporalScope('summarise the July 17, 2026 prospectus')));

    /* HINDSIGHT LEAK: evidence that did not exist at the time asked about. */
    const mixed = buildLedger([
        { kind: 'feed', text: 'GOLDMAN SACHS GROUP INC 424B2 pricing supplement filed.', published: '2026-07-21' },
        { kind: 'feed', text: 'Market commentary ahead of the NVIDIA-linked note pricing.', published: '2026-07-15' },
        { kind: 'document', text: extractDocumentText(REAL_HTML) },   // no publication date
    ]);
    const gated = applyTemporalGate(mixed, parseTemporalScope('what was known as of July 17, 2026'));
    check('gate: post-boundary evidence is excluded', gated.excluded.length === 1 && /filed/.test(gated.excluded[0].text));
    check('gate: pre-boundary evidence survives', gated.ledger.some((e) => /ahead of the NVIDIA/.test(e.text)));
    /* Filings carry no published field. A gate that drops the primary document
       is worse than no gate, so undated evidence is kept and counted. */
    check('gate: the undated primary document is kept, not silently dropped',
        gated.ledger.some((e) => e.kind === 'document') && gated.undated === 1, JSON.stringify({ u: gated.undated }));
    check('gate: does not run on an ungated question',
        applyTemporalGate(mixed, parseTemporalScope('what is a 424B2')).applied === false);

    /* STALE-AS-CURRENT: real figure, resolving citation, out of date. */
    const now = new Date('2026-07-22T12:00:00Z');
    const old = buildLedger([{ kind: 'feed', text: 'GOLDMAN SACHS GROUP INC 424B2 filed.', published: '2026-06-01' }]);
    const f = describeFreshness(old, { now, scope: parseTemporalScope('what is the latest goldman filing') });
    check('fresh: month-old evidence answering "latest" is flagged stale', f.stale === true);
    check('fresh: the age is stated in days', f.ageDays === 51, String(f.ageDays));
    check('fresh: the note refuses the present tense', /not as current/.test(f.note));

    const recent = buildLedger([{ kind: 'feed', text: 'GOLDMAN SACHS GROUP INC 424B2 filed.', published: '2026-07-21' }]);
    check('fresh: yesterday is not stale',
        describeFreshness(recent, { now, scope: parseTemporalScope('latest filing') }).stale === false);
    check('fresh: a timeless question is never stale',
        describeFreshness(old, { now, scope: parseTemporalScope('what is a 424B2') }).stale === false);
    check('fresh: undated evidence cannot claim currency',
        describeFreshness(buildLedger([{ kind: 'document', text: extractDocumentText(REAL_HTML) }]),
            { now, scope: { kind: 'current' } }).stale === true);

    /* The gate has to reach the model, or it is a check nobody keeps. */
    const stalePrompt = buildSynthesisPrompt('latest filing', old, { freshness: f });
    check('prompt: staleness is carried into the prompt', /NOT current/.test(stalePrompt));
    check('prompt: and demands the past tense with the date', /2026-06-01/.test(stalePrompt));
    check('prompt: fresh evidence adds no such rule',
        !/NOT current/.test(buildSynthesisPrompt('latest filing', recent, { freshness: describeFreshness(recent, { now, scope: { kind: 'current' } }) })));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
