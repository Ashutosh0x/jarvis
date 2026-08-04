// One registry for everything the globe can draw.
//
// ---------------------------------------------------------------------------
// WHY A REGISTRY AND NOT JUST MORE FIELDS ON globeMode
//
// Every layer added so far — quakes, fires, flights, events, satellites — was
// wired into globeMode by hand: its own field, its own visibility check, its
// own place in the update loop, its own line in dispose(). That works for five
// and collapses at fifteen, and it leaves the user with no way to turn any of
// them off.
//
// A layer registers ONE object and gets polling, visibility, per-frame updates
// and teardown for free. globeMode stops growing a field per feature.
//
// THE POLL GUARD IS A Set, NOT A BOOLEAN PER LAYER. A slow fetch that outlives
// its own interval would otherwise stack requests — the same failure that had
// OpenSky being asked 2,880 times a day. An id in `inFlight` means skip this
// tick; it is removed in a finally so a thrown fetch cannot wedge the layer
// off permanently.
//
// A LAYER THAT IS OFF COSTS NOTHING. Polling only runs for visible layers, and
// `update(dt)` skips the rest — switching a layer off must actually stop the
// work, not just hide the result.
// ---------------------------------------------------------------------------

/** Category → the colour its dot takes in the panel, and its display order. */
export const CATEGORIES = {
    space: { label: 'Space', colour: '#6fd3ff', order: 1 },
    seismic: { label: 'Seismic', colour: '#ff9d2e', order: 2 },
    aviation: { label: 'Aviation', colour: '#96e6ff', order: 3 },
    cyber: { label: 'Cyber', colour: '#ff4444', order: 4 },
    maritime: { label: 'Maritime', colour: '#ffd27f', order: 5 },
    infrastructure: { label: 'Infrastructure', colour: '#d6a3ff', order: 6 },
    intel: { label: 'Intel', colour: '#ff6b9d', order: 7 },
    environment: { label: 'Environment', colour: '#9ae66e', order: 8 }
};

export function createLayerManager({ globe, statusBar = null, codeOverlay = null } = {}) {
    /** Insertion-ordered; the panel sorts by category itself. */
    const layers = new Map();
    /** Ids with a fetch in flight. See the header — this is why it is a Set. */
    const inFlight = new Set();
    const listeners = new Set();

    function notify() {
        for (const fn of listeners) {
            try { fn(getAll()); } catch { /* a bad listener must not stop the rest */ }
        }
    }

    /**
     * Register a layer.
     *
     * @param {object} spec
     * @param {string} spec.id
     * @param {string} spec.name        shown in the panel
     * @param {string} spec.category    key of CATEGORIES
     * @param {object} [spec.layer]     { update(dt), setData(), dispose(), group }
     * @param {Function} [spec.fetchFn] async () => data, handed to setData
     * @param {number} [spec.pollMs]    0 or absent = fetch once when switched on
     * @param {Function} [spec.onToggle] async (on) => boolean, for layers that
     *                                   own their own visibility
     * @param {boolean} [spec.visible]  start switched on
     */
    function register(spec) {
        if (!spec?.id) throw new Error('a layer needs an id');
        if (layers.has(spec.id)) throw new Error(`duplicate layer id: ${spec.id}`);
        const entry = {
            id: spec.id,
            name: spec.name || spec.id,
            category: CATEGORIES[spec.category] ? spec.category : 'intel',
            layer: spec.layer || null,
            fetchFn: spec.fetchFn || null,
            onToggle: spec.onToggle || null,
            pollMs: Number(spec.pollMs) || 0,
            visible: !!spec.visible,
            lastFetch: 0,
            loading: false,
            /* Last failure, kept so the panel can show WHY a layer is empty
               rather than leaving it looking merely quiet. */
            error: null
        };
        layers.set(entry.id, entry);
        if (entry.visible) void refresh(entry, { force: true });
        notify();
        return entry;
    }

    /** Fetch and hand to the layer. Never throws. */
    async function refresh(entry, { force = false } = {}) {
        if (!entry.fetchFn) return;
        if (inFlight.has(entry.id)) return;
        if (!force && entry.pollMs && Date.now() - entry.lastFetch < entry.pollMs) return;

        inFlight.add(entry.id);
        entry.loading = true;
        entry.error = null;
        notify();
        try {
            const data = await entry.fetchFn();
            entry.layer?.setData?.(data);
            entry.lastFetch = Date.now();
            codeOverlay?.log?.(`layer(${entry.id}) -> ${Array.isArray(data) ? data.length : 'ok'}`);
        } catch (e) {
            /* A layer that cannot load says so once. Silence here is how a
               dead feed comes to look like an empty world. */
            entry.error = e?.message || 'unavailable';
            statusBar?.pushAlert?.(`${entry.name} unavailable — ${entry.error}`, 'alert');
        } finally {
            inFlight.delete(entry.id);
            entry.loading = false;
            notify();
        }
    }

    async function toggle(id, on) {
        const entry = layers.get(id);
        if (!entry) return false;
        const next = typeof on === 'boolean' ? on : !entry.visible;

        /* A layer that owns its visibility (satellites load lazily and can
           refuse) gets the final say — if it declines, the switch does not
           move, so the panel never shows something as on that is not. */
        if (entry.onToggle) {
            const ok = await entry.onToggle(next);
            entry.visible = next && ok !== false;
        } else {
            entry.visible = next;
            entry.layer?.setVisible?.(entry.visible);
            if (entry.layer?.group) entry.layer.group.visible = entry.visible;
        }

        if (entry.visible) await refresh(entry, { force: !entry.lastFetch });
        notify();
        return entry.visible;
    }

    /** Driven from globeMode's update — this module never starts a loop. */
    function update(dt = 0) {
        const now = Date.now();
        for (const entry of layers.values()) {
            if (!entry.visible) continue;
            entry.layer?.update?.(dt);
            /* Polling is per-layer and only while visible. */
            if (entry.pollMs && now - entry.lastFetch >= entry.pollMs) {
                void refresh(entry);
            }
        }
    }

    function getAll() {
        return [...layers.values()]
            .map((e) => ({
                id: e.id, name: e.name, category: e.category,
                visible: e.visible, loading: e.loading, error: e.error
            }))
            .sort((a, b) =>
                (CATEGORIES[a.category].order - CATEGORIES[b.category].order)
                || a.name.localeCompare(b.name));
    }

    const isActive = (id) => !!layers.get(id)?.visible;
    const activeCount = () => [...layers.values()].filter((e) => e.visible).length;

    function onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    /** Switch everything off — used when the globe itself is hidden. */
    function hideAll() {
        for (const entry of layers.values()) {
            if (!entry.visible) continue;
            entry.layer?.setVisible?.(false);
            if (entry.layer?.group) entry.layer.group.visible = false;
        }
    }

    /** Restore whatever was on before hideAll. */
    function restore() {
        for (const entry of layers.values()) {
            if (!entry.visible) continue;
            entry.layer?.setVisible?.(true);
            if (entry.layer?.group) entry.layer.group.visible = true;
        }
    }

    function dispose() {
        for (const entry of layers.values()) {
            try { entry.layer?.dispose?.(); } catch { /* keep disposing the rest */ }
        }
        layers.clear();
        inFlight.clear();
        listeners.clear();
    }

    return {
        register, toggle, isActive, getAll, activeCount, update,
        onChange, hideAll, restore, dispose,
        refresh: (id) => { const e = layers.get(id); return e ? refresh(e, { force: true }) : null; },
        get: (id) => layers.get(id) || null
    };
}

export default { createLayerManager, CATEGORIES };
