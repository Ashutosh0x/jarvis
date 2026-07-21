// ---------------------------------------------------------------------------
// ENS resolution — the one HONEST answer to "who is this address": a name the
// owner cryptographically set on-chain, not a proprietary guess. Keyless and
// deterministic (mainnet ENS registry + resolver, read via eth_call).
//
// This module is pure: it builds namehashes and calldata and decodes results.
// The eth_calls themselves are done by the caller (via the on-chain RPC layer),
// so this stays testable without a network.
// ---------------------------------------------------------------------------

import { keccak256, keccak256Utf8, utf8ToBytes, hexToBytes, bytesToHex, selector } from './keccak.js';

// ENS Registry (same address on Ethereum mainnet and testnets).
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';

// Resolver interface selectors (derived from keccak — verified in tests).
export const ENS_SELECTORS = {
    resolver: selector('resolver(bytes32)'), // 0x0178b8bf on the registry
    addr: selector('addr(bytes32)'),         // 0x3b3b57de on a resolver
    name: selector('name(bytes32)'),         // 0x691f3431 on a resolver
};

const ZERO_NODE = '0x' + '0'.repeat(64);

/** EIP-137 namehash of an ENS name -> 0x-hex 32-byte node. */
export function namehash(name) {
    let node = new Uint8Array(32); // namehash('') = 32 zero bytes
    const n = String(name || '').trim().toLowerCase();
    if (n) {
        const labels = n.split('.');
        for (let i = labels.length - 1; i >= 0; i--) {
            const labelHash = keccak256(utf8ToBytes(labels[i]));
            const combined = new Uint8Array(64);
            combined.set(node, 0);
            combined.set(labelHash, 32);
            node = keccak256(combined);
        }
    }
    return '0x' + bytesToHex(node);
}

/** The reverse-record node for an address: namehash("<addr>.addr.reverse"). */
export function reverseNode(address) {
    const a = String(address || '').toLowerCase().replace(/^0x/, '');
    return namehash(`${a}.addr.reverse`);
}

// Calldata builders (selector + 32-byte node).
export function encodeResolver(node) { return ENS_SELECTORS.resolver + node.replace(/^0x/, ''); }
export function encodeAddr(node) { return ENS_SELECTORS.addr + node.replace(/^0x/, ''); }
export function encodeName(node) { return ENS_SELECTORS.name + node.replace(/^0x/, ''); }

/** Decode a 32-byte word holding a left-padded address; null if zero/empty. */
export function decodeAddress(raw) {
    const h = String(raw || '').replace(/^0x/i, '');
    if (h.length < 40) return null;
    const addr = '0x' + h.slice(-40);
    if (/^0x0{40}$/.test(addr)) return null;
    return addr;
}

export function isZeroNodeResult(raw) {
    return !raw || raw === '0x' || raw === ZERO_NODE || /^0x0*$/.test(raw);
}

/** True if a string looks like an ENS name (has a dot and a known-ish TLD). */
export function looksLikeEnsName(s) {
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(eth|xyz|art|luxe|kred|club|id)$/i.test(String(s || '').trim());
}
