import ragService from './ragService.js';
import factStore, { factsMatch, evidenceStats } from './factStore.js';
import { distillFacts } from '../toolService.js';

/** Human phrasing of a belief's provenance ("3 confirmations: 2 voice, 1 text,
 *  last on <date>") for explainable memory and spoken summaries. */
function provenance(fact) {
    const s = evidenceStats(fact);
    const bits = Object.entries(s.bySource).map(([src, n]) => `${n} ${src}`);
    const last = s.lastTs ? new Date(s.lastTs).toLocaleDateString() : 'unknown';
    return `${s.count} confirmation${s.count === 1 ? '' : 's'}${bits.length ? ` (${bits.join(', ')})` : ''}, last ${last}`;
}

// Two RAG facts are "the same" if their token sets overlap enough — used to
// evict a demoted fact from the RAG regardless of exact phrasing.
const sameFact = factsMatch;

// ---------------------------------------------------------------------------
// Reflection / memory consolidation — the "sleep" pass.
//
// This is the loop that turns raw experience into durable knowledge and
// self-improvement signals. It is the missing link between the two memory
// layers Jarvis already has:
//
//   episodic  interactions.jsonl — every turn, verbatim, append-only. The
//             immutable source of truth (SelfMem keeps the transcript intact).
//   semantic  the hybrid RAG — durable facts recalled during reasoning.
//
// Consolidation reads only the NEW interactions since the last pass, asks Gemma
// to distill stable facts (rejecting volatile detail), and writes those facts
// into the RAG. It also mines the aggregate stats for what is going wrong —
// failing intents, common asks — and records a plain-language reflection.
//
// Deliberately OFF the voice hot path: a Gemma distillation is several seconds,
// so this runs on an explicit "reflect" command or once per day at startup,
// never inside a normal turn. It is idempotent (keyed on the covered timestamp)
// and best-effort (a failure never affects normal operation).
// ---------------------------------------------------------------------------

// A turn only teaches something if the user actually engaged with it; pure
// errors and empty responses are noise for fact distillation.
function usefulRows(rows) {
    return rows.filter((r) => r && r.input && r.ok !== false);
}

// Render rows into a compact transcript for the distiller. Only the fields that
// carry durable signal — what the user asked and how Jarvis answered.
function toTranscript(rows) {
    return rows
        .map((r) => `User: ${r.input}\nJarvis: ${(r.response || '').slice(0, 200)}`)
        .join('\n---\n');
}

// Derive the self-improvement report from the aggregate stats: where Jarvis is
// failing and what it is asked for most. Pure arithmetic — no model call — so
// it is always available even if distillation times out.
function analyzeStats(stats) {
    if (!stats || !stats.success) return null;
    const intents = Object.entries(stats.byIntent || {});
    const topIntents = intents.slice(0, 5).map(([k, v]) => ({ intent: k, count: v }));
    const slowIntents = Object.entries(stats.avgLatencyByIntent || {})
        .filter(([, ms]) => ms > 3000)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, ms]) => ({ intent: k, avgMs: ms }));

    const recommendations = [];
    if (stats.errorRate > 15) {
        recommendations.push(`Error rate is ${stats.errorRate}% — review the failing commands below.`);
    }
    for (const s of slowIntents) {
        recommendations.push(`${s.intent} averages ${(s.avgMs / 1000).toFixed(1)}s — a candidate for caching or a faster path.`);
    }
    // A frequently-used intent that still errors is the highest-value fix.
    return { topIntents, slowIntents, recommendations, errorRate: stats.errorRate };
}

class ReflectionService {
    constructor() {
        this._running = false;
    }

    /**
     * Run one consolidation pass. Returns a spoken-summary string (or a short
     * "nothing new" message). Safe to call repeatedly — only interactions newer
     * than the last pass are processed.
     *
     * `opts.minNew` (default 3): skip if fewer than this many new useful turns,
     * so a trivial session does not trigger a multi-second Gemma call.
     */
    async reflect(opts = {}) {
        if (this._running) return 'A reflection is already in progress.';
        if (!window.electronAPI?.getInteractions) {
            return 'Reflection is not available in this environment.';
        }
        this._running = true;
        try {
            const minNew = opts.minNew ?? 3;

            // 1. Where did the last pass stop? Only process newer experience.
            const prior = await window.electronAPI.getReflections({ limit: 1 }).catch(() => null);
            const sinceTs = prior?.lastCoveredTs || 0;

            const pulled = await window.electronAPI.getInteractions({ sinceTs, limit: 300 });
            const rows = pulled?.rows || [];
            const useful = usefulRows(rows);
            if (useful.length < minNew) {
                return `Nothing significant to consolidate — only ${useful.length} new interaction${useful.length === 1 ? '' : 's'} since I last reflected.`;
            }
            const coveredTs = rows.reduce((m, r) => Math.max(m, Number(r.ts) || 0), sinceTs);

            // 2. Distill candidate facts, then run them through the CONFIDENCE
            //    GATE. Only facts corroborated across passes reach the RAG; a
            //    one-off STT garble stays provisional and never pollutes recall.
            let learned = [];   // facts promoted to durable THIS pass
            let provisional = 0;
            try {
                await factStore.load();
                await this._migratePollutedFacts(); // one-time cleanup of pre-gate facts

                // Weight the batch's evidence by its dominant source — voice/STT
                // is trusted less than typed text, so garble needs more
                // corroboration before it can matter (BeliefMem source weighting).
                const voice = useful.filter((r) => r.source === 'voice').length;
                const source = voice >= useful.length / 2 ? 'voice' : 'text';

                const { facts } = await distillFacts(toTranscript(useful));
                const { promoted, demoted } = factStore.observe(facts, { source });

                // Promote corroborated WINNING candidates into semantic memory,
                // and record each change in the audit log (version history).
                for (const f of promoted) {
                    const r = await ragService.ingest(f.statement, { source: 'reflection' });
                    f.inRag = true;
                    if (r && r.stored > 0) learned.push(f.statement);
                    this._audit('promote', f);
                }
                // Evict demoted/archived facts (incl. revised-away values) from RAG.
                for (const f of demoted) {
                    await ragService.forget((c) => c.source === 'reflection' && sameFact(c.text, f.statement));
                    f.inRag = false;
                    this._audit(f.status === 'archived' ? 'archive' : 'revise', f);
                }
                await factStore.save();
                provisional = factStore.stats().provisional;
            } catch (e) {
                console.warn('Reflection distillation failed (continuing with stats):', e.message);
            }

            // 3. Self-improvement analysis from the aggregate stats.
            let analysis = null;
            try {
                const stats = await window.electronAPI.getInteractionStats();
                analysis = analyzeStats(stats);
            } catch { /* stats optional */ }

            // 4. Persist the reflection (derived knowledge, human-readable).
            await window.electronAPI.saveReflection({
                coveredTs,
                interactionsConsidered: useful.length,
                factsLearned: learned,
                provisionalCount: provisional,
                topIntents: analysis?.topIntents || [],
                slowIntents: analysis?.slowIntents || [],
                recommendations: analysis?.recommendations || [],
                errorRate: analysis?.errorRate ?? null,
            });

            // 5. Spoken summary.
            const parts = [];
            parts.push(`I reviewed ${useful.length} recent interaction${useful.length === 1 ? '' : 's'}.`);
            if (learned.length) {
                parts.push(`I confirmed ${learned.length} thing${learned.length === 1 ? '' : 's'} into long-term memory: ${learned.slice(0, 3).join('; ')}.`);
            } else if (provisional > 0) {
                // The gate at work: candidates are held, not committed, until a
                // later pass corroborates them.
                parts.push(`Nothing new was corroborated enough to commit yet — I am holding ${provisional} candidate fact${provisional === 1 ? '' : 's'} provisionally.`);
            } else {
                parts.push('Nothing durable enough to add to long-term memory.');
            }
            if (analysis?.recommendations?.length) {
                parts.push(`One improvement I noted: ${analysis.recommendations[0]}`);
            }
            return parts.join(' ');
        } finally {
            this._running = false;
        }
    }

    /** Append a belief change to the memory audit log (version history). */
    _audit(action, fact) {
        try {
            const s = evidenceStats(fact);
            window.electronAPI?.logMemoryEvent?.({
                action, // promote | revise | archive
                attribute: fact.attribute,
                value: fact.value,
                statement: fact.statement,
                confidence: +fact.confidence.toFixed(3),
                confirmations: s.count,
                sources: s.bySource,
            });
        } catch { /* audit is best-effort */ }
    }

    /**
     * Sleep-like auto-consolidation: run at most once per DAY, only when there
     * is genuinely new experience. Called at startup so knowledge compounds
     * without the user having to ask. Silent no-op when it is not yet due.
     * Returns the summary string if it ran, else null.
     */
    async maybeAutoReflect() {
        try {
            if (!window.electronAPI?.getReflections) return null;
            const prior = await window.electronAPI.getReflections({ limit: 1 });
            const last = prior?.reflections?.[0]?.ts || 0;
            const dayMs = 20 * 60 * 60 * 1000; // ~once/day, with slack
            if (Date.now() - last < dayMs) return null;
            const summary = await this.reflect({ minNew: 5 });
            return summary.startsWith('Nothing') ? null : summary;
        } catch (e) {
            console.warn('Auto-reflection skipped:', e.message);
            return null;
        }
    }

    /** Speak back what is DURABLY known ("what have you learned / know about
     *  me"). Reads the confidence ledger, not the last reflection, so it reports
     *  corroborated facts rather than unconfirmed candidates. */
    async lastReflectionSummary() {
        try {
            await factStore.load();
            const durable = factStore.durableFacts();
            if (durable.length) {
                // Highest-confidence first, WITH provenance — the things Jarvis is
                // surest of, and why it believes them.
                const top = durable.sort((a, b) => b.confidence - a.confidence).slice(0, 4)
                    .map((f) => `${f.statement} — ${Math.round(f.confidence * 100)}% sure, from ${provenance(f)}`);
                return `Here is what I am most confident I have learned about you: ${top.join('. ')}.`;
            }
            const s = factStore.stats();
            if (s.provisional > 0) {
                return `I have not confirmed anything into long-term memory yet, but I am tracking ${s.provisional} candidate fact${s.provisional === 1 ? '' : 's'} that will be committed once I see them corroborated.`;
            }
            return 'I have not consolidated any durable memories yet. Say "reflect" after we have interacted more.';
        } catch {
            return 'I could not read my memory.';
        }
    }

    /**
     * ONE-TIME migration: facts written straight to the RAG by the pre-gate
     * reflection are pulled into the ledger as PROVISIONAL and evicted from the
     * RAG, so they are subject to corroboration going forward. This is what
     * cleans the already-polluted state (the "Uruguay"/"loopstrand" garble).
     * Runs at most once — guarded by a flag persisted in the ledger.
     */
    async _migratePollutedFacts() {
        if (factStore._migratedPreGate) return;
        try {
            await ragService.load();
            const preGate = (ragService.chunks || []).filter((c) => c.source === 'reflection');
            if (preGate.length) {
                factStore.importProvisional(preGate.map((c) => c.text));
                await ragService.forget((c) => c.source === 'reflection');
                console.log(`Reflection: migrated ${preGate.length} pre-gate facts to provisional and evicted from RAG.`);
            }
        } catch (e) {
            console.warn('Pre-gate fact migration skipped:', e.message);
        } finally {
            // Session guard. Cross-restart safety is automatic: after the first
            // run the RAG has no reflection-source chunks, so a re-run is a no-op.
            factStore._migratedPreGate = true;
        }
    }
}

const reflectionService = new ReflectionService();
export default reflectionService;
