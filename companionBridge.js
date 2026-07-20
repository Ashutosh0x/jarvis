/* =========================
   JARVIS COMPANION BRIDGE (desktop side)

   Owns everything the Android companion talks to:
     - a WebSocket command server (phone dials in, desktop issues commands)
     - mDNS advertisement so the phone finds this machine with no typing
     - a time-boxed pairing window that gates token handout

   The HTTP surface (/pair, /apk, QR page) lives on the existing phone bridge
   in electron.js so there is one LAN listener to reason about, not two.
========================= */

const { WebSocketServer } = require('ws');
const { Bonjour } = require('bonjour-service');
const crypto = require('crypto');

const WS_PORT = 8766;
const COMMAND_TIMEOUT_MS = 20000;
const PAIRING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

class CompanionBridge {
    /**
     * @param {object} opts
     * @param {() => string} opts.getToken       current phone-bridge token
     * @param {(evt: object) => void} opts.onEvent   phone -> desktop events
     * @param {() => void} [opts.onDevicesChanged]
     */
    constructor(opts) {
        this.getToken = opts.getToken;
        this.onEvent = opts.onEvent || (() => {});
        this.onDevicesChanged = opts.onDevicesChanged || (() => {});

        this.wss = null;
        this.bonjour = null;
        this.service = null;

        /** @type {Map<string, {socket: any, info: object}>} */
        this.devices = new Map();
        /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
        this.pending = new Map();

        this.pairingUntil = 0;
    }

    /* ---------- pairing window ---------- */

    openPairingWindow(ms = PAIRING_WINDOW_MS) {
        this.pairingUntil = Date.now() + ms;
        console.log(`Companion pairing window open for ${Math.round(ms / 1000)}s`);
        return this.pairingUntil;
    }

    closePairingWindow() {
        this.pairingUntil = 0;
    }

    get isPairingOpen() {
        return Date.now() < this.pairingUntil;
    }

    /* ---------- lifecycle ---------- */

    start(bridgePort) {
        this.startWsServer();
        this.advertise(bridgePort);
    }

    startWsServer() {
        if (this.wss) return;

        this.wss = new WebSocketServer({ port: WS_PORT, path: '/ws' });

        this.wss.on('connection', (socket, req) => {
            // Constant-time compare: a naive === on a secret leaks length and
            // prefix through timing to anyone on the LAN.
            const supplied = req.headers['x-jarvis-token'] || '';
            const expected = this.getToken() || '';
            if (!safeEqual(supplied, expected)) {
                console.warn('Companion rejected: bad token from', req.socket.remoteAddress);
                socket.close(4001, 'invalid token');
                return;
            }

            const id = crypto.randomBytes(6).toString('hex');
            const remote = req.socket.remoteAddress;
            this.devices.set(id, { socket, info: { id, remote } });
            console.log(`Companion connected: ${id} (${remote})`);
            this.onDevicesChanged();

            socket.on('message', (raw) => this.handleMessage(id, raw));

            socket.on('close', () => {
                this.devices.delete(id);
                console.log(`Companion disconnected: ${id}`);
                this.onDevicesChanged();
            });

            socket.on('error', (e) => {
                console.warn(`Companion socket error (${id}):`, e.message);
            });
        });

        this.wss.on('error', (e) => {
            console.error('Companion WS server error:', e.message);
        });

        console.log(`Companion command server listening on ws://0.0.0.0:${WS_PORT}/ws`);
    }

    advertise(bridgePort) {
        try {
            this.bonjour = new Bonjour();
            // Advertises the HTTP bridge port; the phone fetches /pair there and
            // is told the WS port in the response, so only one port is discovered.
            this.service = this.bonjour.publish({
                name: 'JARVIS-Desktop',
                type: 'jarvis',
                protocol: 'tcp',
                port: bridgePort,
                txt: { ws: String(WS_PORT), v: '1' }
            });
            console.log(`Companion mDNS advertising _jarvis._tcp on ${bridgePort}`);
        } catch (e) {
            // Not fatal: the phone can still be pointed at the IP by QR.
            console.warn('Companion mDNS advertise failed:', e.message);
        }
    }

    stop() {
        for (const [, entry] of this.devices) {
            try { entry.socket.close(1000, 'desktop shutdown'); } catch { /* noop */ }
        }
        this.devices.clear();

        if (this.wss) {
            try { this.wss.close(); } catch { /* noop */ }
            this.wss = null;
        }
        if (this.bonjour) {
            try { this.bonjour.unpublishAll(() => this.bonjour.destroy()); } catch { /* noop */ }
            this.bonjour = null;
        }
    }

    /* ---------- messaging ---------- */

    handleMessage(deviceId, raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            console.warn('Companion sent malformed JSON');
            return;
        }

        // Command reply -> settle the waiting promise.
        if (msg.id && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.ok) entry.resolve(msg.result ?? null);
            else entry.reject(new Error(msg.error || 'command failed'));
            return;
        }

        // Unsolicited event (hello, notification, clipboard, battery).
        if (msg.event) {
            if (msg.event === 'hello') {
                const dev = this.devices.get(deviceId);
                if (dev) {
                    // Carries `capabilities`, so the desktop can reason about
                    // what this phone can do instead of probing by failure.
                    dev.info = { ...dev.info, ...(msg.payload || {}) };
                    const caps = dev.info.capabilities || {};
                    const enabled = Object.keys(caps).filter((k) => caps[k]);
                    console.log(`Companion identified: ${dev.info.model || 'unknown'} (Android ${dev.info.android}) — ${enabled.length} capabilities`);
                    this.onDevicesChanged();
                }
            }
            this.onEvent({ deviceId, event: msg.event, payload: msg.payload || {} });
        }
    }

    /**
     * Sends a command and resolves with the phone's result.
     * @param {string} action
     * @param {object} params
     * @param {string} [deviceId] defaults to the only connected device
     */
    send(action, params = {}, deviceId = null) {
        return new Promise((resolve, reject) => {
            const target = deviceId
                ? this.devices.get(deviceId)
                : this.devices.values().next().value;

            if (!target) {
                reject(new Error('no companion device connected'));
                return;
            }

            const id = crypto.randomBytes(8).toString('hex');
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`command '${action}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
            }, COMMAND_TIMEOUT_MS);

            this.pending.set(id, { resolve, reject, timer });

            try {
                target.socket.send(JSON.stringify({ id, action, params }));
            } catch (e) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    listDevices() {
        return Array.from(this.devices.values()).map((d) => d.info);
    }
}

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    // timingSafeEqual throws on length mismatch, so compare lengths first —
    // but always run the comparison to keep the timing profile flat.
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

module.exports = { CompanionBridge, WS_PORT, PAIRING_WINDOW_MS };
