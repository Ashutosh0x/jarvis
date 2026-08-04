// The dossier panel: a right-side intel card that appears when the globe
// locks onto a place, showing photographs and ground-truth data.
//
// ---------------------------------------------------------------------------
// NOTHING IS SHOWN WITHOUT DATA. An empty panel would read as broken; a panel
// with a spinner would read as "your internet is slow". If there is no dossier
// and no images, the panel stays hidden — the status bar already says enough.
//
// IMAGES ROTATE AUTOMATICALLY. Each photograph fades to the next every 5
// seconds, with indicator dots and attribution. The carousel is paused on
// hover so the user can read the credits.
//
// ATTRIBUTION IS ALWAYS VISIBLE. Every image source (Wikipedia, Wikimedia,
// Google, Esri) has licence obligations. The panel renders the photographer
// name and licence for every visible frame.
// ---------------------------------------------------------------------------

const CAROUSEL_MS = 5000;

/**
 * Create the dossier panel.
 *
 * @param {HTMLElement} mount  the DOM parent (usually document.body)
 */
/**
 * Local time from a UTC offset in seconds.
 *
 * Duplicated from googleServices rather than imported so this panel stays a
 * pure DOM component with no service dependency — it is four lines, and the
 * offset is the only input.
 */
function localTime(utcOffsetSec, now = new Date()) {
    if (!Number.isFinite(utcOffsetSec)) return null;
    const d = new Date(now.getTime() + utcOffsetSec * 1000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

export function createDossierPanel({ mount }) {
    const root = document.createElement('div');
    root.className = 'globe-dossier';
    root.innerHTML = `
        <button class="dossier-close" title="Close">&times;</button>
        <div class="globe-dossier-header">
            <h3 class="dossier-name">—</h3>
            <div class="dossier-subtitle"></div>
        </div>
        <div class="dossier-images">
            <div class="no-image">No imagery available</div>
            <div class="img-attribution"></div>
            <div class="img-dots"></div>
        </div>
        <div class="dossier-data"></div>
        <div class="dossier-events"></div>`;
    mount.appendChild(root);

    const nameEl = root.querySelector('.dossier-name');
    const subtitleEl = root.querySelector('.dossier-subtitle');
    const imagesEl = root.querySelector('.dossier-images');
    const noImageEl = root.querySelector('.no-image');
    const attrEl = root.querySelector('.img-attribution');
    const dotsEl = root.querySelector('.img-dots');
    const dataEl = root.querySelector('.dossier-data');
    const eventsEl = root.querySelector('.dossier-events');

    let images = [];
    let currentIndex = 0;
    let carouselTimer = null;
    let paused = false;

    root.querySelector('.dossier-close').addEventListener('click', () => hide());
    imagesEl.addEventListener('mouseenter', () => { paused = true; });
    imagesEl.addEventListener('mouseleave', () => { paused = false; });

    function showImage(index) {
        currentIndex = index;
        const imgs = imagesEl.querySelectorAll('img');
        imgs.forEach((img, i) => img.classList.toggle('active', i === index));
        const dots = dotsEl.querySelectorAll('.img-dot');
        dots.forEach((dot, i) => dot.classList.toggle('active', i === index));

        const current = images[index];
        if (current?.attribution?.name) {
            const parts = [current.attribution.name];
            if (current.license?.name) parts.push(current.license.name);
            if (current.provider) parts.push(`via ${current.provider}`);
            attrEl.textContent = parts.join(' · ');
        } else {
            attrEl.textContent = '';
        }
    }

    function startCarousel() {
        stopCarousel();
        if (images.length <= 1) return;
        carouselTimer = setInterval(() => {
            if (!paused) showImage((currentIndex + 1) % images.length);
        }, CAROUSEL_MS);
    }

    function stopCarousel() {
        if (carouselTimer) { clearInterval(carouselTimer); carouselTimer = null; }
    }

    /** Build a single data row. */
    function row(icon, label, value, cls = '') {
        return `<div class="dossier-row">
            <span class="dr-icon">${icon}</span>
            <span class="dr-label">${label}</span>
            <span class="dr-value${cls ? ` ${cls}` : ''}">${value}</span>
        </div>`;
    }

    /**
     * Show the panel with data.
     *
     * @param {object} opts
     * @param {string} opts.name        e.g. "San Francisco"
     * @param {string} opts.country     e.g. "United States"
     * @param {object} opts.dossier     from google.dossier()
     * @param {Array}  opts.images      from placeImages.forPlace()
     */
    function show({ name, country, dossier, images: imgs = [], events: evts = [] }) {
        /* If there is genuinely nothing to show, stay hidden. The status bar
           already displays the target name and any alerts. */
        if (!dossier && imgs.length === 0 && evts.length === 0) return;

        nameEl.textContent = name || '—';
        subtitleEl.textContent = country || '';

        /* --- images --- */
        images = imgs;
        currentIndex = 0;
        /* Remove old images */
        imagesEl.querySelectorAll('img').forEach(el => el.remove());
        dotsEl.innerHTML = '';

        if (images.length) {
            noImageEl.style.display = 'none';
            for (let i = 0; i < images.length; i++) {
                const img = document.createElement('img');
                img.src = images[i].url;
                img.alt = images[i].title || name;
                img.loading = 'lazy';
                /* Insert before the attribution overlay */
                imagesEl.insertBefore(img, attrEl);

                const dot = document.createElement('div');
                dot.className = 'img-dot';
                dot.addEventListener('click', () => showImage(i));
                dotsEl.appendChild(dot);
            }
            showImage(0);
            startCarousel();
        } else {
            noImageEl.style.display = '';
            attrEl.textContent = '';
            stopCarousel();
        }

        /* --- data rows ---
           THE FIELD NAMES HERE ARE FLAT, and that is not a style choice: the
           panel previously read `dossier.weather.temperature`,
           `dossier.timezone.localTime` and `dossier.airQuality.index`, while
           `googleServices.dossier()` has always returned `temperatureC`,
           `utcOffsetSec` and `aqi` at the top level. Every guard failed, so
           the panel rendered its images and then an empty data block —
           silently, because absent data is a supported state here.

           Absent is still not zero: a field Google did not answer is omitted,
           and a genuine 0°C still prints. */
        const rows = [];
        if (dossier) {
            const t = localTime(dossier.utcOffsetSec);
            if (t) rows.push(row('🕐', 'Local', t));

            if (Number.isFinite(dossier.temperatureC)) {
                const desc = dossier.condition ? `, ${String(dossier.condition).toLowerCase()}` : '';
                rows.push(row('🌡', 'Temp', `${Math.round(dossier.temperatureC)}°C${desc}`));
            } else if (dossier.condition) {
                rows.push(row('🌡', 'Weather', String(dossier.condition)));
            }

            if (Number.isFinite(dossier.aqi)) {
                const a = dossier.aqi;
                const cls = a <= 50 ? 'good' : a <= 100 ? 'moderate' : 'unhealthy';
                /* Google supplies its own category text; use it rather than
                   re-deriving bands that may not match their scale. */
                const label = dossier.aqiCategory
                    ? String(dossier.aqiCategory).replace(/ air quality$/i, '')
                    : (a <= 50 ? 'Good' : a <= 100 ? 'Moderate' : a <= 150 ? 'Sensitive' : 'Unhealthy');
                rows.push(row('🌬', 'AQI', `${a} — ${label}`, cls));
            }

            if (Number.isFinite(dossier.elevationM)) {
                rows.push(row('⛰', 'Elevation', `${Math.round(dossier.elevationM)} m`));
            }
            if (dossier.timeZoneId) rows.push(row('🌍', 'Zone', dossier.timeZoneId));
            if (dossier.streetViewDate) rows.push(row('📷', 'Street View', dossier.streetViewDate));
        }
        dataEl.innerHTML = rows.join('');

        /* --- events --- */
        renderEvents(evts);

        /* Slide in */
        requestAnimationFrame(() => root.classList.add('visible'));
    }

    /**
     * The events section.
     *
     * Times are rendered in the EVENT's timezone, not the viewer's — an event
     * in Tokyo starting at 18:00 must not read as 09:00 because the desk is in
     * London. Luma returns an IANA zone per event for exactly this.
     *
     * Cover images are remote URLs from Luma's CDN and are allowed to fail:
     * `onerror` hides the image rather than leaving a broken-image glyph, and
     * the card still reads without it.
     */
    function renderEvents(list) {
        if (!eventsEl) return;
        eventsEl.innerHTML = '';
        const items = (list || []).filter((e) => e && e.name);
        if (!items.length) { eventsEl.style.display = 'none'; return; }
        eventsEl.style.display = '';

        const head = document.createElement('div');
        head.className = 'dossier-events-head';
        head.textContent = items.length === 1 ? '1 event' : `${items.length} events`;
        eventsEl.appendChild(head);

        for (const e of items.slice(0, 6)) {
            const card = document.createElement('a');
            card.className = 'dossier-event';
            if (e.url) { card.href = e.url; card.target = '_blank'; card.rel = 'noopener noreferrer'; }

            if (e.coverUrl) {
                const img = document.createElement('img');
                img.src = e.coverUrl;
                img.alt = '';
                img.loading = 'lazy';
                img.onerror = () => img.remove();
                card.appendChild(img);
            }

            const body = document.createElement('div');
            body.className = 'dossier-event-body';

            const title = document.createElement('div');
            title.className = 'dossier-event-name';
            title.textContent = e.name;
            body.appendChild(title);

            const meta = document.createElement('div');
            meta.className = 'dossier-event-meta';
            const bits = [];
            if (e.startAt) {
                try {
                    bits.push(new Date(e.startAt).toLocaleString('en-GB', {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                        timeZone: e.timezone || 'UTC'
                    }));
                } catch { /* an unparseable date is simply not shown */ }
            }
            if (e.city) bits.push(e.city);
            /* Only stated when Luma actually reported it — "0 spots" and "no
               figure given" are different facts. */
            if (Number.isFinite(e.spotsRemaining)) bits.push(`${e.spotsRemaining} spots`);
            meta.textContent = bits.join(' · ');
            body.appendChild(meta);

            card.appendChild(body);
            eventsEl.appendChild(card);
        }
    }

    function hide() {
        root.classList.remove('visible');
        stopCarousel();
    }

    function setVisible(on) {
        if (!on) hide();
    }

    function dispose() {
        stopCarousel();
        root.remove();
    }

    return { show, hide, setVisible, dispose, root };
}

export default { createDossierPanel };
