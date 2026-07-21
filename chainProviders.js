// ---------------------------------------------------------------------------
// Keyed provider layer — Alchemy (EVM) and Helius (Solana).
//
// DESIGN RULE, from the way the rest of this app earns its answers: nothing in
// here is trusted because it was typed into a table. Alchemy's per-network
// subdomains are arbitrary strings that only Alchemy knows, so instead of
// shipping a slug map and hoping, we PROBE each candidate and make it prove
// itself by returning the chain ID we already know that chain has. A slug that
// answers with the wrong chain is discarded; a slug that does not answer is
// discarded. What survives is a map the network confirmed, not one I asserted.
//
// A failed probe is itself data: it is cached as a negative result so a chain
// the plan does not cover stops costing a round trip on every query.
//
// AIR-GAP: read-only, same as the keyless RPC service this sits in front of.
// No signing, no key material beyond the provider API keys themselves, and
// those are read from the environment and never logged.
// ---------------------------------------------------------------------------

const KEY_ENV = {
    alchemy: 'ALCHEMY_API_KEY',
    helius: 'HELIUS_API_KEY',
};

/**
 * Resolve a provider key. The environment wins; the credential vault is the
 * fallback so a key can be added by voice at runtime without editing .env.
 * @param {(name: string) => Promise<string|null>} [getCredential]
 */
async function resolveKey(provider, getCredential) {
    const env = process.env[KEY_ENV[provider]];
    if (env && env.trim()) return env.trim();
    if (getCredential) {
        const v = await getCredential(`${provider}_api_key`).catch(() => null);
        if (v && String(v).trim()) return String(v).trim();
    }
    return null;
}

/* --- URL construction ------------------------------------------------------
   Verified live against both APIs on 21 Jul 2026 before being written down.
   Alchemy accepts the key either in the path or as a bearer token; the path
   form is used because it is what the dashboard's own examples emit. */

const alchemyRpcUrl = (slug, key) => `https://${slug}.g.alchemy.com/v2/${key}`;
const alchemyPricesBySymbolUrl = (key, symbols) =>
    `https://api.g.alchemy.com/prices/v1/${key}/tokens/by-symbol?` +
    symbols.map((s) => `symbols=${encodeURIComponent(s)}`).join('&');
const alchemyPricesByAddressUrl = (key) =>
    `https://api.g.alchemy.com/prices/v1/${key}/tokens/by-address`;
const alchemyTokensByAddressUrl = (key) =>
    `https://api.g.alchemy.com/data/v1/${key}/assets/tokens/by-address`;

const heliusRpcUrl = (key) => `https://mainnet.helius-rpc.com/?api-key=${key}`;
const heliusTxByAddressUrl = (address, key, limit) =>
    `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${key}&limit=${limit}`;

/* --- network discovery -----------------------------------------------------
   Candidates, not conclusions. Alchemy names Arbitrum "arb-mainnet" and
   Polygon "polygon-mainnet", but those are their naming choices and they have
   changed before (matic-mainnet -> polygon-mainnet), so each is a guess that
   must be confirmed by eth_chainId before it is used for anything. */
function slugCandidates(chainKey) {
    const guesses = {
        ethereum: ['eth-mainnet'],
        arbitrum: ['arb-mainnet', 'arbitrum-mainnet'],
        base: ['base-mainnet'],
        optimism: ['opt-mainnet', 'optimism-mainnet'],
        polygon: ['polygon-mainnet', 'matic-mainnet'],
        bsc: ['bnb-mainnet', 'bsc-mainnet'],
    };
    return guesses[chainKey] || [`${chainKey}-mainnet`];
}

/**
 * Probe one slug and make it prove which chain it is.
 * @returns {Promise<{ok: true, chainId: number}|{ok: false, reason: string}>}
 */
async function probeSlug(slug, key, expectedChainId, fetchImpl, timeoutMs = 6000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetchImpl(alchemyRpcUrl(slug, key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
            signal: ac.signal,
        });
        if (!res.ok) return { ok: false, reason: `http ${res.status}` };
        const j = await res.json();
        if (j.error) return { ok: false, reason: j.error.message || 'rpc error' };
        const chainId = parseInt(j.result, 16);
        if (!Number.isFinite(chainId)) return { ok: false, reason: 'no chain id' };
        // The load-bearing check: the endpoint must be the chain we think it is.
        if (expectedChainId && chainId !== expectedChainId) {
            return { ok: false, reason: `chain id mismatch: got ${chainId}, expected ${expectedChainId}` };
        }
        return { ok: true, chainId };
    } catch (e) {
        return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : (e.message || 'failed') };
    } finally {
        clearTimeout(t);
    }
}

/**
 * Discover which chains this Alchemy key can actually serve.
 *
 * @param {string} key
 * @param {Record<string, {id: number}>} chains  chain metadata (id = expected chain id)
 * @param {Function} fetchImpl
 * @returns {Promise<{verified: Record<string, {slug: string, chainId: number, url: string}>, rejected: Record<string, string>}>}
 */
async function discoverAlchemyNetworks(key, chains, fetchImpl) {
    const verified = {};
    const rejected = {};
    if (!key) return { verified, rejected };

    /* A rejection means two different things and they deserve different
       treatment. "http 403" or a chain-id mismatch is a VERDICT — the key does
       not serve this network, and asking again will not change that. A timeout
       or a failed connection is NOISE, and observed live: one startup dropped
       Ethereum entirely because a single probe took longer than six seconds,
       leaving the session on public endpoints for the chain that matters most.
       Transient failures are retried once; verdicts are not. */
    const isTransient = (reason) => /timeout|failed|ENOTFOUND|ECONN|socket|network|http 5\d\d|http 429/i.test(reason || '');

    await Promise.all(Object.entries(chains).map(async ([chainKey, meta]) => {
        const reasons = [];
        for (const slug of slugCandidates(chainKey)) {
            let r = await probeSlug(slug, key, meta.id, fetchImpl);
            if (!r.ok && isTransient(r.reason)) {
                reasons.push(`${slug}: ${r.reason} (retrying)`);
                r = await probeSlug(slug, key, meta.id, fetchImpl, 10000);
            }
            if (r.ok) {
                verified[chainKey] = { slug, chainId: r.chainId, url: alchemyRpcUrl(slug, key) };
                return;
            }
            reasons.push(`${slug}: ${r.reason}`);
        }
        // Negative result, kept on purpose — this is why a chain is missing.
        rejected[chainKey] = reasons.join('; ');
    }));

    return { verified, rejected };
}

module.exports = {
    KEY_ENV,
    resolveKey,
    alchemyRpcUrl,
    alchemyPricesBySymbolUrl,
    alchemyPricesByAddressUrl,
    alchemyTokensByAddressUrl,
    heliusRpcUrl,
    heliusTxByAddressUrl,
    slugCandidates,
    probeSlug,
    discoverAlchemyNetworks,
};
