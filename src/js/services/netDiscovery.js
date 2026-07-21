// ---------------------------------------------------------------------------
// Network DISCOVERY parsing — pure, no I/O. Companion to netInspect.js:
// that module answers "what sockets are open on this machine", this one
// answers "what else is out there" (Wi-Fi networks in range, LAN neighbours,
// paired Bluetooth devices).
//
// WHY THIS EXISTS: the interaction log shows Gemma answering "what's the IP of
// pro haven" with "192.168.1.10" — an address it invented. Nothing resolved,
// nothing was measured, and the number was stated as fact. Every function here
// returns only what a real command reported, so those questions can be
// answered deterministically instead of guessed.
// ---------------------------------------------------------------------------

/* Split a netsh "Key : Value" line on the FIRST colon — BSSIDs and MACs
   contain colons, so splitting on the last one corrupts them.

   Two shapes in real output broke an earlier version of this and are both
   covered by tests: "Connected Stations:         3" has NO space before the
   colon, and a hidden network prints "SSID 2 :" with an empty value (which
   must still open a new network, or its fields silently overwrite the
   previous one's). netsh keys never contain a colon, so first-colon is safe. */
function kv(line) {
    const m = String(line).match(/^(.+?)\s*:\s*(.*)$/);
    if (!m) return null;
    return { key: m[1].trim().toLowerCase(), value: m[2].trim() };
}

/**
 * Parse `netsh wlan show networks mode=bssid` into structured networks.
 * One SSID can advertise several BSSIDs (mesh/repeaters); each is kept with
 * its own signal and channel so "which access point am I near" is answerable.
 */
export function parseWifiNetworks(text) {
    const nets = [];
    let cur = null, bss = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        const p = kv(line);
        if (!p) continue;

        // "SSID 3 : name" starts a network. A hidden network reports an empty name.
        if (/^ssid\s+\d+$/.test(p.key)) {
            if (bss && cur) cur.bssids.push(bss);
            if (cur) nets.push(cur);
            bss = null;
            cur = { ssid: p.value || '(hidden)', auth: null, encryption: null, type: null, bssids: [] };
            continue;
        }
        if (!cur) continue;

        if (p.key === 'authentication') { cur.auth = p.value; continue; }
        if (p.key === 'encryption') { cur.encryption = p.value; continue; }
        if (p.key === 'network type') { cur.type = p.value; continue; }

        if (/^bssid\s+\d+$/.test(p.key)) {
            if (bss) cur.bssids.push(bss);
            bss = { bssid: p.value.toLowerCase(), signal: null, radio: null, band: null, channel: null, stations: null };
            continue;
        }
        if (!bss) continue;
        if (p.key === 'signal') { const n = parseInt(p.value, 10); bss.signal = Number.isFinite(n) ? n : null; continue; }
        if (p.key === 'radio type') { bss.radio = p.value; continue; }
        if (p.key === 'band') { bss.band = p.value; continue; }
        if (p.key === 'channel') { const n = parseInt(p.value, 10); bss.channel = Number.isFinite(n) ? n : null; continue; }
        if (p.key === 'connected stations') { const n = parseInt(p.value, 10); bss.stations = Number.isFinite(n) ? n : null; continue; }
    }
    if (bss && cur) cur.bssids.push(bss);
    if (cur) nets.push(cur);

    // Strongest first — that is the order a person asks about.
    for (const n of nets) n.bssids.sort((a, b) => (b.signal || 0) - (a.signal || 0));
    return nets.sort((a, b) => (b.bssids[0]?.signal || 0) - (a.bssids[0]?.signal || 0));
}

/** Best signal across a network's access points, or null. */
export function bestSignal(network) {
    const s = (network?.bssids || []).map(b => b.signal).filter(v => typeof v === 'number');
    return s.length ? Math.max(...s) : null;
}

/**
 * Fuzzy SSID match for speech. STT mangles network names badly ("pro heaven"
 * for "Pro Haven", "temple tree 2nd 25G" for "Temple tree 2nd 2_5G"), so
 * matching normalises away case, spaces, underscores and punctuation, then
 * falls back to a containment test either direction.
 */
export function matchNetwork(networks, spoken) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(spoken);
    if (!want || !Array.isArray(networks)) return null;
    let exact = null, partial = null;
    for (const n of networks) {
        const have = norm(n.ssid);
        if (!have) continue;
        if (have === want) return n;
        if (!exact && (have.includes(want) || want.includes(have))) partial = partial || n;
    }
    return exact || partial;
}

/** Parse `arp -a` into LAN neighbours, grouped per interface. Multicast and
 *  broadcast rows are dropped: they are protocol plumbing, not devices. */
export function parseArpTable(text) {
    const out = [];
    let iface = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        const im = line.match(/^Interface:\s+([0-9.]+)/i);
        if (im) { iface = im[1]; continue; }
        const m = line.match(/^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+(\w+)/i);
        if (!m) continue;
        const ip = m[1];
        const mac = m[2].toLowerCase();
        if (mac === 'ff-ff-ff-ff-ff-ff') continue;            // broadcast
        if (mac.startsWith('01-00-5e')) continue;             // IPv4 multicast
        if (/^(224|239)\./.test(ip)) continue;                // multicast range
        out.push({ ip, mac, type: m[3].toLowerCase(), iface });
    }
    return out;
}

/* MAC vendor lookup is DELIBERATELY NOT IMPLEMENTED as a built-in table.
   An earlier version shipped nine hand-picked OUI prefixes, which is a guess
   list wearing the costume of a database: it names a handful of devices and
   silently mislabels or ignores every other one, and it cannot be checked
   against anything. The authoritative IEEE OUI registry is ~35k entries and
   is not present on Windows, so there is nothing local to consult.

   The locally VERIFIABLE facts about a neighbour are its IP, its MAC, and
   whatever reverse DNS returns — those are reported instead. Locally
   administered addresses are the one thing the MAC itself proves, because
   that is defined by a bit in the address rather than by a registry. */

/**
 * What the MAC address itself can prove, with no lookup table.
 * Returns { locallyAdministered, multicast } or null.
 */
export function macFacts(mac) {
    const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
    if (hex.length !== 12) return null;
    const first = parseInt(hex.slice(0, 2), 16);
    if (!Number.isFinite(first)) return null;
    return {
        // Bit 1 of the first octet: set means randomised/assigned locally
        // (phones with MAC privacy, VMs), not a manufacturer-registered address.
        locallyAdministered: (first & 0b10) !== 0,
        multicast: (first & 0b1) !== 0,
    };
}

/**
 * Parse the Bluetooth PnP device list. Windows exposes one PnP node per
 * *service* (AVRCP transport, A2DP, …), so the same headset appears several
 * times; entries are deduped to the device the user would name.
 */
export function parseBluetoothDevices(rows) {
    const SERVICE_NOISE = /\b(enumerator|rfcomm|avrcp|a2dp|hands-?free|headset service|device identification|protocol tdi|personal area|audio gateway|remote control|obex)\b/i;
    const seen = new Map();
    for (const r of rows || []) {
        const name = String(r?.name || '').trim();
        if (!name) continue;
        const isAdapter = /\badapter\b/i.test(name);
        const isService = SERVICE_NOISE.test(name);
        // Strip the service suffix so "OnePlus Buds 3 Avrcp Transport" folds
        // into the "OnePlus Buds 3" the user actually owns.
        const base = name.replace(/\s+(avrcp\s+transport|a2dp|hands-?free|audio\s+gateway|remote\s+control).*$/i, '').trim();
        const key = base.toLowerCase();
        const prev = seen.get(key);
        const entry = {
            name: base,
            status: String(r?.status || '').trim(),
            connected: String(r?.status || '').toUpperCase() === 'OK',
            kind: isAdapter ? 'adapter' : (isService && base === name ? 'service' : 'device'),
        };
        // Keep the most informative record: a connected one beats an unknown one.
        if (!prev || (entry.connected && !prev.connected)) seen.set(key, entry);
    }
    return [...seen.values()]
        .filter(d => d.kind !== 'service')
        .sort((a, b) => (b.connected - a.connected) || a.name.localeCompare(b.name));
}
