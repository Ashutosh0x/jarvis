/**
 * @fileoverview Security advisories — Chrome Releases and NVD.
 *
 * PURE: parsing and formatting only. No network, no clock except where passed.
 *
 * WHY THIS EXISTS. From the interaction log of 21 Jul 2026:
 *
 *   "latest cve number of chrome 2026 july today 21"
 *     -> "CVE-2026-15905 is the latest CRITICAL vulnerability for Chrome"
 *   (the user, a security researcher, corrects it: 15905 is rated High)
 *     -> "The latest critical vulnerability is CVE-2026-15899"
 *
 * Nothing was retrieved for either answer. The first instinct was to add a
 * guard that blocks ungrounded CVE identifiers — but a guard only converts a
 * wrong answer into no answer. Chrome Releases publishes an RSS feed and NVD
 * serves severity keyless, so the fix is to READ THE ADVISORY. The guard stays
 * as a backstop for everything this does not cover.
 *
 * FORMAT VERIFIED against the live feed (21 Jul 2026), not assumed. Entries
 * read:  [N/A][ 516987782 ] Critical CVE-2026-15899: Use after free in
 * CameraCapture. Reported by Google on 2026-05-27
 * The bracketed prefix is a bounty amount and a bug id, and both vary — the
 * severity, id, and description are what parse reliably.
 */

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };

/** Decode the HTML entities Blogger wraps its post bodies in. */
function decodeEntities(s) {
    return String(s || '')
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Strip markup and collapse whitespace so one regex can span the body. */
function toPlainText(html) {
    return decodeEntities(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Pull the CVE table out of one advisory body.
 * @returns {Array<{id, severity, component, description}>}
 */
export function parseAdvisoryCves(html) {
    const text = toPlainText(html);
    const out = [];
    const seen = new Set();
    const re = /\b(Critical|High|Medium|Low)\s+(CVE-\d{4}-\d{4,7})\s*:\s*([^.]{0,120})\./gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const id = m[2].toUpperCase();
        if (seen.has(id)) continue;
        seen.add(id);
        const description = m[3].trim();
        // "Use after free in CameraCapture" -> component CameraCapture. The
        // component is the part a researcher scans for, so it is extracted
        // rather than left inside the sentence.
        const comp = description.match(/\bin\s+([A-Za-z0-9 ._/-]{2,40})$/);
        out.push({
            id,
            severity: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(),
            component: comp ? comp[1].trim() : null,
            description,
        });
    }
    return out;
}

/** RSS -> advisories, newest first. Posts with no CVEs are kept but marked. */
export function parseAdvisoryFeed(xml, { limit = 10 } = {}) {
    const items = [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit * 3);
    const pick = (block, tag) => {
        const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return m ? decodeEntities(m[1]).trim() : '';
    };
    const posts = items.map(([, block]) => {
        const published = pick(block, 'pubDate');
        const ts = Date.parse(published);
        const cves = parseAdvisoryCves(pick(block, 'description'));
        return {
            title: pick(block, 'title'),
            url: pick(block, 'link'),
            published: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
            publishedTs: Number.isFinite(ts) ? ts : null,
            cves,
            securityUpdate: cves.length > 0,
        };
    });
    // Newest first, and only where the feed gave a usable date.
    return posts.sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0)).slice(0, limit);
}

/** NVD payload -> the authoritative severity for one CVE, or null. */
export function parseNvdCve(payload) {
    const v = payload?.vulnerabilities?.[0]?.cve;
    if (!v?.id) return null;
    const metrics = v.metrics || {};
    // Prefer the newest CVSS version present; older records only carry v2.
    const data = metrics.cvssMetricV40?.[0]?.cvssData
        || metrics.cvssMetricV31?.[0]?.cvssData
        || metrics.cvssMetricV30?.[0]?.cvssData
        || metrics.cvssMetricV2?.[0]?.cvssData
        || null;
    const english = (v.descriptions || []).find(d => d.lang === 'en');
    return {
        id: v.id,
        baseScore: Number.isFinite(data?.baseScore) ? data.baseScore : null,
        severity: data?.baseSeverity || null,
        vector: data?.vectorString || null,
        published: v.published || null,
        source: v.sourceIdentifier || null,
        description: english?.description || null,
        // Absent scores are common for very recent CVEs; that is a real state
        // and is reported rather than filled in.
        awaitingAnalysis: !data,
    };
}

/** Highest severity first, then id, so the ordering is stable. */
export function sortBySeverity(cves) {
    return [...(cves || [])].sort((a, b) => {
        const d = (SEVERITY_ORDER[String(b.severity).toLowerCase()] || 0) - (SEVERITY_ORDER[String(a.severity).toLowerCase()] || 0);
        return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
    });
}

export function countBySeverity(cves) {
    const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    for (const c of cves || []) {
        const k = String(c.severity || '').toLowerCase();
        const key = Object.keys(counts).find(x => x.toLowerCase() === k);
        if (key) counts[key]++;
    }
    return counts;
}

/**
 * Spoken summary of one advisory. Reads the counts and the most severe few by
 * name — a researcher wants the identifiers, and the counts give the shape.
 */
export function describeAdvisory(post, { limit = 3 } = {}) {
    if (!post) return 'I have no advisory to report, Sir.';
    if (!post.cves?.length) {
        return `The most recent Chrome release, ${post.title}, carries no security fixes, Sir.`;
    }
    const counts = countBySeverity(post.cves);
    const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.toLowerCase()}`);
    const ranked = sortBySeverity(post.cves).slice(0, limit);
    const named = ranked.map(c => `${c.id}, ${c.severity.toLowerCase()}, ${c.description}`).join('. ');
    return `${post.title} patches ${post.cves.length} ${post.cves.length === 1 ? 'issue' : 'issues'}, Sir: ${parts.join(', ')}. ` +
        `The most severe: ${named}.`;
}

/** Spoken summary of one CVE looked up by identifier. */
export function describeCve(cve) {
    if (!cve) return 'I have no record for that identifier, Sir.';
    if (cve.awaitingAnalysis) {
        return `${cve.id} is published but has no CVSS score assigned yet, Sir. ` +
            (cve.description ? `It is described as: ${String(cve.description).slice(0, 220)}` : 'No description is available yet.');
    }
    return `${cve.id} is rated ${String(cve.severity || '').toLowerCase()}, with a CVSS base score of ${cve.baseScore}, Sir. ` +
        (cve.description ? String(cve.description).slice(0, 260) : '');
}

/* --- multi-source verification ----------------------------------------------
   From the Trustworthy-RAG survey (arXiv 2409.10102): retrieval alone is not
   enough — accountability needs EVIDENCE VERIFICATION, "whether the information
   is correct", not merely "where it came from". And from GASP (arXiv 2607.04223,
   Jul 2026): a hallucination is a failure of DEPENDENCE on evidence rather than
   a property of the text.

   GASP's own method is not implementable here — it scores each sentence by the
   log-likelihood drop when its context is removed, and Ollama returns no token
   logprobs on either /api/generate or /v1/completions (probed, both empty). So
   the deterministic form of the same idea is used instead: ask two independent
   authorities and compare. Agreement raises confidence; DISAGREEMENT IS
   REPORTED, never silently resolved by preferring one source.

   This matters concretely: a vendor publishes severity days before NVD finishes
   its CVSS analysis, so "NVD has no score yet" and "the vendor says High" are
   both true at once and the honest answer states both. */

/**
 * @param {{severity?: string}|null} vendor  e.g. Google's advisory entry
 * @param {{severity?: string, baseScore?: number, awaitingAnalysis?: boolean}|null} nvd
 * @returns {{status, confidence, sources: string[], severity: string|null, conflict: object|null}}
 */
export function crossVerify(vendor, nvd, { vendorName = 'the vendor advisory' } = {}) {
    const v = vendor?.severity ? String(vendor.severity).toUpperCase() : null;
    const n = nvd?.severity ? String(nvd.severity).toUpperCase() : null;
    const sources = [];
    if (v) sources.push(vendorName);
    if (n) sources.push('NVD');

    if (!v && !n) {
        // Nothing authoritative. This is the case that used to produce an
        // invented severity, so it must remain an explicit non-answer.
        return { status: 'unverified', confidence: 0, sources: [], severity: null, conflict: null };
    }
    if (v && n && v !== n) {
        return {
            status: 'conflict', confidence: 0.5, sources, severity: null,
            conflict: { vendor: v, nvd: n, vendorName },
        };
    }
    if (v && n) {
        // Two independent authorities agree — the strongest state available.
        return { status: 'confirmed', confidence: 1, sources, severity: v, conflict: null };
    }
    // Exactly one source. Real and common: NVD lags the vendor by days.
    return {
        status: 'single-source', confidence: 0.6, sources,
        severity: v || n, conflict: null,
        pending: !!(v && nvd?.awaitingAnalysis),
    };
}

/** Speak the verification state, including disagreement, never hiding it. */
export function describeVerification(result, cveId) {
    if (!result || result.status === 'unverified') {
        return `I could not verify ${cveId} against NVD or a vendor advisory, Sir, so I will not state a severity for it.`;
    }
    if (result.status === 'conflict') {
        const c = result.conflict;
        return `The sources disagree on ${cveId}, Sir. ${c.vendorName} rates it ${c.vendor.toLowerCase()}, ` +
            `while the NVD rates it ${c.nvd.toLowerCase()}. I am not going to pick one for you.`;
    }
    if (result.status === 'confirmed') {
        return `${cveId} is rated ${result.severity.toLowerCase()}, Sir, confirmed by ${result.sources.join(' and ')}.`;
    }
    const only = result.sources[0];
    return `${cveId} is rated ${result.severity.toLowerCase()} according to ${only}, Sir` +
        (result.pending ? ', and the NVD has not finished scoring it yet.' : ', the only source I could verify it against.');
}

/** "CVE-2026-15905" out of free text, or null. */
export function extractCveId(text) {
    const m = String(text || '').match(/\bCVE[-\s]?(\d{4})[-\s]?(\d{4,7})\b/i);
    return m ? `CVE-${m[1]}-${m[2]}` : null;
}

export default {
    parseAdvisoryCves, parseAdvisoryFeed, parseNvdCve,
    sortBySeverity, countBySeverity, describeAdvisory, describeCve, extractCveId,
    crossVerify, describeVerification,
};
