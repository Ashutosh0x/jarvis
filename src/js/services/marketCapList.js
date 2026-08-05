/* =========================================================================
   WHERE THE COMPANY LIST COMES FROM.

   Live ranking first, bundled file second. That order is the whole point:
   the bundled list was transcribed by hand from a web page, so it is stale
   the day it ships and carries no rank, price or market cap. The API has all
   of it and is current. But a globe that draws nothing without a paid API
   would be worse than one with a stale list, so the file remains — as a
   fallback that SAYS it is one, never as a silent substitute.

   CREDITS. One uncached page is one credit and one page is 100 companies.
   Nothing here loops over pages by itself; `topCompanies` takes a count, works
   out the pages that implies, and reports how many credits it actually spent
   versus how many it avoided by using the cache. A number a user cannot see
   is a number they cannot control.
   ========================================================================= */

const PAGE_SIZE = 100;

export function createMarketCapList({ bridge, statusBridge, fallback = [] }) {
    let status = null;

    async function refreshStatus() {
        if (!statusBridge) return null;
        status = await statusBridge().catch(() => null);
        return status;
    }

    /** Is the live source usable at all? Absence of a key is a normal state. */
    async function available() {
        if (!bridge) return false;
        if (!status) await refreshStatus();
        return !!status?.configured;
    }

    /**
     * The top N companies by market cap.
     *
     * Returns the entries plus an honest account of where they came from and
     * what they cost. `source` is 'api' or 'bundled' — never blended silently,
     * because a caller showing "live market caps" over stale bundled names
     * would be presenting a claim the data does not support.
     */
    async function topCompanies(count = 100, { country = null } = {}) {
        const wanted = Math.max(1, Number(count) || 100);
        const pages = Math.ceil(wanted / PAGE_SIZE);

        /* THE CRAWLED FILE COMES FIRST, and it is free.
           `scripts/fetch-ranking.mjs` buys the ranking once; after that the
           whole database is on disk and costs nothing to read. Going to the
           metered endpoint when a local copy exists would spend a credit to
           learn something already known — and would do it on every launch. */
        if (bridge) {
            const local = await bridge('localRanking', { limit: wanted, country }).catch(() => null);
            if (local?.ok && local.data?.available && local.data.companies?.length) {
                return {
                    source: 'crawled',
                    entries: local.data.companies,
                    creditsSpent: 0,
                    cachedPages: local.data.pages,
                    fetchedAt: local.data.fetchedAt,
                    totalAvailable: local.data.total,
                    failures: []
                };
            }
        }

        if (await available()) {
            const entries = [];
            let credits = 0, cachedPages = 0;
            const failures = [];
            for (let p = 1; p <= pages; p++) {
                const res = await bridge('ranking', { page: p }).catch((e) => ({ ok: false, reason: String(e) }));
                if (!res?.ok) { failures.push({ page: p, reason: res?.reason, detail: res?.detail }); break; }
                if (res.cached) cachedPages++; else credits++;
                entries.push(...(res.data?.companies || []));
                if ((res.data?.companies || []).length < PAGE_SIZE) break;   // ran out of ranking
            }
            if (entries.length) {
                return {
                    source: 'api',
                    entries: entries.slice(0, wanted),
                    creditsSpent: credits,
                    cachedPages,
                    failures
                };
            }
            /* Every page failed. Say why, then fall back — silently serving the
               bundled list here is how a dead API becomes invisible. */
            return {
                source: 'bundled',
                entries: fallback.slice(0, wanted),
                creditsSpent: credits,
                cachedPages,
                failures,
                degraded: failures[0]?.reason || 'no-data'
            };
        }

        return {
            source: 'bundled',
            entries: fallback.slice(0, wanted),
            creditsSpent: 0,
            cachedPages: 0,
            failures: [],
            degraded: status?.configured === false ? 'no-key' : 'unavailable'
        };
    }

    /** Resolve a spoken name to the API's identifier. One credit, cached. */
    async function findCompany(query) {
        if (!bridge || !query) return null;
        const res = await bridge('search', { query: String(query) }).catch(() => null);
        return res?.ok ? (res.data?.results?.[0] || null) : null;
    }

    /** The full profile: rank, price, country, categories, description,
        revenue and earnings history. One credit, cached for half a day. */
    async function companyDetails(identifier) {
        if (!bridge || !identifier) return null;
        const res = await bridge('details', { identifier: String(identifier) }).catch(() => null);
        return res?.ok ? res.data : null;
    }

    /** Year-by-year history of one metric. */
    async function metricHistory(identifier, metric) {
        if (!bridge || !identifier || !metric) return null;
        const res = await bridge('metricHistory', {
            identifier: String(identifier), metric: String(metric)
        }).catch(() => null);
        return res?.ok ? res.data : null;
    }

    return { available, refreshStatus, topCompanies, findCompany, companyDetails, metricHistory, PAGE_SIZE };
}

export default { createMarketCapList };
