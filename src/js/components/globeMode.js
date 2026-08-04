// Globe mode: the command-centre view, and the switch into and out of it.
//
// ---------------------------------------------------------------------------
// IT SHARES THE ORB'S SCENE, CAMERA AND RENDER LOOP
//
// scripts.js already owns a WebGL context, a camera and a requestAnimationFrame
// loop for the orb. Standing a second renderer beside it would mean two GL
// contexts, two loops and two cameras fighting over the same canvas — and on a
// 4 GB card, two sets of GPU buffers for a view only one of which is visible.
//
// So the globe is a Group inside the existing scene, hidden by default, and
// this module is driven from the existing animate(). Switching modes toggles
// visibility and swaps who controls the camera. Nothing about the orb changes,
// which is the point: F3 must be able to go back.
//
// THE CAMERA IS THE ONE SHARED THING THAT NEEDS CARE. The orb loop lerps the
// camera toward the mouse every frame; OrbitControls wants to own it entirely.
// Both writing to it produces a camera that drifts while you drag. Orb mode's
// mouse-follow is therefore suppressed while the globe is up (see the
// `ownsCamera` flag scripts.js reads), and the camera position is saved and
// restored across the switch so the orb comes back exactly as it was.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { createGlobe, latLngToVector3 } from './globeRenderer.js';
import { createMarkerLayer } from './globeMarkers.js';
import { createCodeOverlay } from './codeOverlay.js';
import { createStatusBar } from './statusBar.js';
import { createDataFeeds, describeEvent, distanceKm } from '../services/dataFeeds.js';
import { geocode, buildPlaceIndex, findLocal } from '../services/geocode.js';
import { createLandmarkService } from '../services/landmarks.js';
import { createGoogleServices, describeDossier, cameraDistanceFor } from '../services/googleServices.js';
import { createPlaceImages } from '../services/placeImages.js';
import { createDossierPanel } from './dossierPanel.js';
import { buildAirportIndex, primaryAirport } from '../services/airports.js';
import { createSatelliteService } from '../services/satellites.js';
import { createSatelliteLayer } from './layers/satelliteLayer.js';
import { createLayerManager } from './globeLayers.js';
import { createLayerPanel } from './layerPanel.js';

/* Files the code column scrolls through — real modules, not filler.
 *
 * Imported with Vite's `?raw` so the text is INLINED into the bundle. Fetching
 * them by URL works in `npm run dev` and 404s in the packaged app, where the
 * sources no longer exist as files — a column that is empty in production and
 * full in development is the worst of both.
 *
 * Chosen for size and for looking like something: jarvis.js is 420 KB and
 * would bloat the bundle for text nobody reads past line 60. These four are
 * ~90 KB together and are the most legible code in the project. */
import globeSrc from './globeRenderer.js?raw';
import emitterSrc from '../services/foundry/bpyEmitter.js?raw';
import searchSrc from '../services/webSearchIntent.js?raw';
import specSrc from '../services/foundry/sceneSpec.js?raw';

const CODE_SOURCES = ['globeRenderer.js', 'bpyEmitter.js', 'webSearchIntent.js', 'sceneSpec.js'];
const CODE_TEXT = {
    'globeRenderer.js': globeSrc,
    'bpyEmitter.js': emitterSrc,
    'webSearchIntent.js': searchSrc,
    'sceneSpec.js': specSrc
};

/**
 * Load a bundled GeoJSON.
 *
 * IPC FIRST, fetch second. Under `npm run electron` the page is loaded with
 * loadFile(), so its origin is file:// and Chromium refuses fetch() on that
 * scheme — every layer failed and the globe rendered as a black sphere with no
 * coastlines. The main process reads it from disk instead. The fetch path is
 * kept for `npm run dev`, where the page is served over http and there is no
 * Electron bridge to ask.
 */
async function loadJson(name) {
    const api = window.electronAPI;
    if (api?.loadGeoAsset) {
        const res = await api.loadGeoAsset(name);
        if (res?.ok) return res.data;
        throw new Error(res?.error || `could not read ${name}`);
    }
    const res = await fetch(`geo/${name}`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res.json();
}

/** Source text comes from the inlined map, so it works offline and packaged. */
async function loadText(name) {
    const text = CODE_TEXT[name];
    if (!text) throw new Error(`no inlined source for ${name}`);
    return text;
}

/* Where a point came from, in the reference's uppercase-tag style. Unknown
   provenance gets no tag rather than a decorative one. */
const SOURCE_TAGS = {
    local: 'NATURAL EARTH',
    nominatim: 'OSM',
    wikipedia: 'WIKIPEDIA',
    google: 'GOOGLE',
    luma: 'LUMA',
    caller: ''
};

export function labelFor(name, source) {
    const tag = SOURCE_TAGS[source];
    const base = String(name ?? '').toUpperCase();
    return tag ? `${base} (${tag})` : base;
}

export async function createGlobeMode({ scene, camera, renderer }) {
    const mount = document.body;

    /* CSS2DRenderer needs its own transparent, click-through layer above the
       WebGL canvas. pointer-events:none on the container and auto on the
       labels themselves, or the whole overlay would swallow the drag that is
       supposed to rotate the globe. */
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.className = 'globe-label-layer';
    mount.appendChild(labelRenderer.domElement);

    const globe = await createGlobe({
        scene, camera,
        domElement: renderer.domElement,
        loadGeoJson: loadJson
    });

    const markers = createMarkerLayer({ scene, camera, globeGroup: globe.group });
    const statusBar = createStatusBar({ mount });
    const codeOverlay = createCodeOverlay({
        mount, loadSource: loadText, files: CODE_SOURCES
    });
    const dossierPanel = createDossierPanel({ mount });

    /* Places index: bundled, so a city lookup works with no network. */
    let placeIndex = [];
    loadJson('ne_110m_populated_places_simple.geojson')
        .then((g) => { placeIndex = buildPlaceIndex(g); })
        .catch((e) => {
            /* Reported, because losing this silently turns every lookup into a
               network round trip and makes offline geocoding fail for reasons
               nobody can see. */
            console.error('Globe: offline place index unavailable —', e.message);
        });

    /* Airports, for turning a city into an IATA code by proximity. Bundled and
       public domain — see airports.js for why this is not a name table. */
    let airportIndex = [];
    loadJson('airports_iata.json')
        .then((j) => { airportIndex = buildAirportIndex(j); })
        .catch((e) => console.error('Globe: airport index unavailable —', e.message));

    /* Satellites. The elements are fetched lazily — the first time the layer
       is switched on — because most sessions never ask for them and CelesTrak
       does not need pinging for a view nobody opened. */
    const satelliteService = createSatelliteService();
    const satelliteLayer = createSatelliteLayer(globe);
    let satellitesLoaded = false;

    async function setSatellites(on) {
        if (on && !satellitesLoaded) {
            statusBar.setTarget(null, 'Acquiring orbital elements...');
            const r = await satelliteService.load('stations');
            if (!r.ok) {
                /* Keyless, so a failure here is a real network or upstream
                   problem. Saying so beats an empty sky that looks identical
                   to "no satellites". */
                statusBar.pushAlert(`Orbital elements unavailable — ${r.reason}`, 'alert');
                return false;
            }
            satelliteLayer.setData(r.sats);
            satellitesLoaded = true;
            statusBar.pushAlert(`${r.sats.length} tracked objects in view`, 'alert');
            codeOverlay.log(`satellites.load('stations') -> ${r.sats.length} elements`);
        }
        satelliteLayer.setVisible(on);
        return on;
    }

    /* Everything drawable, in one registry. The existing feeds are migrated
       in below rather than left as bespoke fields — five hand-wired layers
       works, fifteen does not, and none of them were switchable before. */
    const layerManager = createLayerManager({ globe, statusBar, codeOverlay });
    const layerPanel = createLayerPanel(layerManager);

    layerManager.register({
        id: 'satellites', name: 'Satellites', category: 'space',
        layer: satelliteLayer,
        /* Owns its own visibility: the elements load lazily and the load can
           fail, in which case the switch must not move. */
        onToggle: setSatellites
    });
    layerManager.register({
        id: 'earthquakes', name: 'Earthquakes', category: 'seismic', visible: true,
        layer: {
            setVisible: (on) => { feeds.feeds.earthquakes.visible = on; },
            group: null
        }
    });
    layerManager.register({
        id: 'wildfires', name: 'Wildfires', category: 'environment',
        layer: { setVisible: (on) => { feeds.feeds.wildfires.visible = on; }, group: null }
    });
    layerManager.register({
        id: 'flights', name: 'Aircraft', category: 'aviation',
        layer: { setVisible: (on) => { feeds.feeds.flights.visible = on; }, group: null }
    });
    layerManager.register({
        id: 'events', name: 'Luma events', category: 'intel',
        layer: { setVisible: (on) => { feeds.feeds.events.visible = on; }, group: null }
    });

    const landmarkService = createLandmarkService();
    const google = createGoogleServices();
    const placeImages = createPlaceImages();

    const feeds = createDataFeeds({
        onEvents: (events) => {
            if (!active) return;
            /* Only the notable ones get a ripple: every M2.5 on Earth is a few
               hundred a day and the globe would be permanently boiling. */
            for (const e of events.slice(0, 12)) {
                if (e.kind === 'earthquake' && (e.magnitude ?? 0) >= 4.5) {
                    markers.addRipple({ lat: e.lat, lng: e.lng, maxScale: 0.4 + e.weight });
                } else if (e.kind === 'wildfire') {
                    markers.addRipple({ lat: e.lat, lng: e.lng, maxScale: 0.3 + e.weight, colour: 0xff6b2e });
                }
            }
            const top = events[0];
            if (top) statusBar.pushAlert(describeEvent(top), (top.magnitude ?? 0) >= 5.5 ? 'breaking' : 'alert');
        }
    });

    let active = false;
    let savedCamera = null;

    function setActive(on) {
        if (on === active) return active;
        active = on;

        if (on) {
            savedCamera = camera.position.clone();
            /* Start off the coast of west Africa at 0,0 — the whole sphere in
               frame, which is the shot the reference opens on. */
            camera.position.set(0, 0, globe.radius * 3);
            camera.lookAt(0, 0, 0);
            globe.controls.target.set(0, 0, 0);
        } else if (savedCamera) {
            camera.position.copy(savedCamera);
            camera.lookAt(scene.position);
        }

        globe.setVisible(on);
        /* Layers follow the globe: hidden when it is, and restored to whatever
           was switched on when it comes back. */
        if (on) layerManager.restore(); else layerManager.hideAll();
        if (!on) { satelliteLayer.setVisible(false); layerPanel.hide(); }
        /* The status bar and code overlay complete the Iron Man command-centre
           aesthetic. The bar shows the target, weather/time dossier and seismic
           alerts; the column scrolls real source code with live log entries. */
        statusBar.setVisible(on);
        /* The scrolling source column is off. It is still built and still fed
           (codeOverlay.log stays the record of what the globe is doing), but
           it is not drawn — asked for directly, and it competes with the
           dossier for the same attention. One line to bring it back. */
        codeOverlay.setVisible(false);
        dossierPanel.setVisible(on);
        labelRenderer.domElement.style.display = on ? 'block' : 'none';
        document.body.classList.toggle('globe-mode', on);

        if (on) {
            /* The column is not drawn, so nothing scrolls it. */
            feeds.start();
            /* Say what the globe is actually showing. A map that came up with
               no coastlines should announce that, not leave the user deciding
               whether an almost-black sphere is a bug or the design. */
            const errors = globe.geoErrors();
            if (errors.length) {
                statusBar.setTarget(null, `Map data unavailable — ${errors.length} layer${errors.length === 1 ? '' : 's'} failed to load.`);
                statusBar.pushAlert(errors[0], 'breaking');
                console.error('Globe layers loaded:', globe.loadedLayers().join(', ') || 'none');
            }
        }
        return active;
    }

    /**
     * Show a place: fly there, label it, ripple any events near it.
     *
     * This is what "show me what's happening in San Francisco" reaches.
     */
    async function showLocation(query, { landmarks = [], speak = null } = {}) {
        /* A COMMAND IS NOT A PLACE. If the whole utterance arrives here —
           "show me bengaluru" rather than "bengaluru" — the parser upstream
           failed to extract, and geocoding it wastes a network round trip to
           produce a confusing "no coordinates found for <your sentence>".
           Stripping the lead verb recovers the intent instead of failing it,
           and the strip is reported so the parser bug stays visible rather
           than being papered over silently. */
        const stripped = String(query || '').replace(
            /^\s*(?:jarvis[,\s]+)?(?:show|display|pull\s+up|bring\s+up|take|fly|zoom|go|bring|point|look)\s+(?:me\s+|my\s+|us\s+)?(?:to\s+|at\s+|the\s+)*/i, ''
        ).trim();
        if (stripped && stripped !== String(query).trim()) {
            console.warn('Globe: a command reached showLocation, not a place —', JSON.stringify(query));
            codeOverlay.log(`showLocation recovered "${query}" -> "${stripped}"`);
            query = stripped;
        }

        /* Offline gazetteer first — it is instant, free and works on a train.
           Google is consulted only when that comes back empty or unsure, which
           is where the bundled data's gaps are: Natural Earth 110m has "New
           Delhi" but no "Delhi", and no Trichardt at all. */
        let place = await geocode(query, { index: placeIndex });
        /* The offline index holds CITIES ONLY. A country, a state, a street or
           a building is not in it and never will be at 162 KB, so anything it
           cannot answer — and anything it answers without confidence — goes to
           Google, which resolves all five granularities with one call. */
        if ((!place || place.score < 0.8 || !place.spanKm) && google.available()) {
            const better = await google.geocode(query);
            if (better && (!place || better.score >= place.score)) {
                codeOverlay.log(`google.geocode("${query}") -> ${better.name} [${better.granularity}]`);
                place = better;
            }
        }
        if (!place) {
            statusBar.setTarget(null, `No coordinates found for "${query}".`);
            return { ok: false, error: `I could not find ${query} on the map` };
        }

        if (!active) setActive(true);
        codeOverlay.log(`geocode("${query}") -> ${place.lat.toFixed(3)}, ${place.lng.toFixed(3)} [${place.source}]`);

        markers.clear();
        globe.clearArcs?.();
        globe.setAutoRotate(false);
        statusBar.setTarget(place.name, 'Acquiring target parameters...');

        /* Framing comes from the extent Google measured, not from a table of
           zoom levels per place type. Places with no viewport (the offline
           index has none) keep the old city-sized default. */
        const flyDistance = Number.isFinite(place.spanKm)
            ? cameraDistanceFor(place.spanKm, globe.radius)
            : globe.radius * 1.9;
        /* Places API caps its circle at 50 km, so a country ring saturates
           there rather than asking for something that would be rejected. */
        const ringRadiusKm = Number.isFinite(place.spanKm)
            ? Math.max(2, Math.min(50, place.spanKm / 4))
            : 10;

        /* Fired BEFORE the fly-to and awaited after it. The flight is 2.4s of
           animation the user is already watching; spending it on a request
           that would otherwise be dead time is why the labels appear with the
           camera rather than a beat behind it.
           An explicit `landmarks` argument still wins — the caller knowing
           better is not something to override. */
        const ringPromise = landmarks.length
            ? Promise.resolve({ items: landmarks, source: 'caller', attribution: null })
            /* The city pin is drawn separately, so it is declared taken — a
               landmark sitting on top of it prints both labels through each
               other. */
            /* The ring scales with the target. Ten kilometres around Japan
               finds one suburb of Tokyo and calls it the country; ten around a
               street address is the whole city. Both radius and the spacing
               between labels come from the measured extent. */
            : landmarkService.near(place.lat, place.lng, {
                radiusKm: ringRadiusKm,
                limit: 5,
                minSeparationKm: Math.max(1, ringRadiusKm / 4),
                exclude: [{ lat: place.lat, lng: place.lng }]
            });

        /* Ground truth at the target — local time, weather, elevation, air
           quality, whether Street View has been there. Fired alongside the
           landmarks and never awaited before the camera moves: the fly-to must
           not wait on five web requests, and a dossier that fails costs a line
           of text, not the flight. */
        const dossierPromise = google.available()
            ? google.dossier(place.lat, place.lng).catch(() => null)
            : Promise.resolve(null);

        /* Photographs of the target, on the same footing: started here,
           awaited at the end, never in front of the camera. */
        const imagesPromise = placeImages.forPlace(place, { limit: 4 }).catch(() => ({ images: [] }));

        await globe.flyTo(place.lat, place.lng, { distance: flyDistance, ms: 2400 });

        /* The label tag used to be the literal string "(WIRE)" on every marker
           — copied off the reference footage, meaning nothing, and identical
           whether the coordinates came from the bundled gazetteer, Nominatim
           or Wikipedia. A constant dressed as data is exactly what this
           project does not ship, so the tag now names where the point actually
           came from, and says nothing when that is unknown. */
        markers.addMarker({
            lat: place.lat, lng: place.lng,
            label: labelFor(place.name, place.source),
            pin: true, boxed: true
        });

        const ring = await ringPromise;
        for (const l of ring.items.slice(0, 5)) {
            markers.addMarker({
                lat: l.lat, lng: l.lng,
                label: labelFor(l.name, l.source ?? ring.source),
                boxed: !!l.boxed
            });
        }
        if (ring.items.length) {
            codeOverlay.log(`landmarks.near(${place.name}) -> ${ring.items.length} [${ring.source}]`);
        }
        /* Google's terms require visible credit when their place data is drawn
           on a map that is not theirs. Saying it out loud in the ticker is the
           minimum; the logo obligation is documented in landmarks.js. */
        if (ring.attribution === 'Google') statusBar.pushAlert('Place data: Google', 'alert');
        markers.addRipple({ lat: place.lat, lng: place.lng, maxScale: 0.55, rings: 3 });

        const nearby = feeds.near(place.lat, place.lng, 900);
        for (const e of nearby.slice(0, 4)) {
            markers.addRipple({ lat: e.lat, lng: e.lng, maxScale: 0.35 + e.weight, colour: 0xff5a3c });
        }

        statusBar.setTarget(place.name, nearby.length
            ? `${nearby.length} seismic event${nearby.length === 1 ? '' : 's'} within 900 km.`
            : 'Tracking target parameters.');
        for (const e of nearby.slice(0, 2)) statusBar.pushAlert(describeEvent(e), 'alert');

        codeOverlay.log(`feeds.near(${place.lat.toFixed(2)}, ${place.lng.toFixed(2)}) -> ${nearby.length} events`);

        /* Awaited last, so nothing above waited on it. */
        const facts = await dossierPromise;
        const line = describeDossier(facts);
        if (line) {
            statusBar.pushAlert(`${place.name}: ${line}`, 'alert');
            codeOverlay.log(`google.dossier(${place.name}) -> ${line}`);
        }

        const pictures = await imagesPromise;
        if (pictures.images.length) {
            codeOverlay.log(`placeImages(${place.name}) -> ${pictures.images.length} from ${[...new Set(pictures.images.map((i) => i.provider))].join(', ')}`);
        }

        /* Events on this calendar that are near the target. Their radius
           scales with the place: "events in Japan" should reach the whole
           country, "events on this street" should not reach the next city. */
        const eventRadiusKm = Number.isFinite(place.spanKm)
            ? Math.max(25, Math.min(2000, place.spanKm))
            : 100;
        const nearbyEvents = feeds.near(place.lat, place.lng, eventRadiusKm)
            .filter((e) => e.kind === 'event');
        for (const e of nearbyEvents.slice(0, 6)) {
            markers.addMarker({
                lat: e.lat, lng: e.lng,
                label: labelFor(e.name, 'luma'),
                kind: 'event'
            });
        }

        /* Aircraft overhead, fetched NOW rather than read from the ambient
           15-minute poll — see flightsNear(). Only drawn for city-sized
           targets and smaller: at country scale the box would cover a
           continent, and a hundred pins would bury the place itself. */
        let flights = [];
        const flightRadiusKm = Number.isFinite(place.spanKm)
            ? Math.max(60, Math.min(250, place.spanKm))
            : 150;
        if (!Number.isFinite(place.spanKm) || place.spanKm <= 400) {
            const air = await feeds.flightsNear(place.lat, place.lng, flightRadiusKm).catch(() => null);
            if (air?.ok) {
                flights = air.flights;
                for (const f of flights.slice(0, 12)) {
                    markers.addMarker({
                        lat: f.lat, lng: f.lng,
                        label: f.callsign || 'AIRCRAFT',
                        kind: 'flight'
                    });
                }
                if (flights.length) {
                    codeOverlay.log(`flightsNear(${place.name}, ${flightRadiusKm}km) -> ${flights.length} aircraft`);
                }
            }
        }

        /* Show the dossier panel with images and ground-truth data. */
        dossierPanel.show({
            name: place.name,
            country: place.country || '',
            dossier: facts,
            images: pictures.images,
            events: nearbyEvents,
            flights
        });

        return {
            ok: true, place, nearby, source: place.source,
            landmarks: ring.items, dossier: facts, events: nearbyEvents, flights,
            /* Each carries its own attribution; anything rendering these MUST
               show it — see the header of placeImages.js. */
            images: pictures.images
        };
    }

    /**
     * Plot a corridor between two places and mark what is flying over it.
     *
     * The arc is drawn as a GREAT CIRCLE, which is the path aircraft actually
     * fly — a straight line on the sphere between Bengaluru and Tokyo would cut
     * through the planet, and a straight line on a flat map would be the wrong
     * route entirely.
     *
     * The aircraft are real and current. Their DESTINATIONS are not known: see
     * `flightsAlongRoute` for why the open feed cannot supply them. Nothing
     * here implies these aircraft are travelling between the two named cities.
     */
    async function showRoute(fromQuery, toQuery) {
        const resolve = async (q) => {
            let p = await geocode(q, { index: placeIndex });
            if ((!p || p.score < 0.8) && google.available()) p = (await google.geocode(q)) || p;
            return p;
        };
        const [from, to] = await Promise.all([resolve(fromQuery), resolve(toQuery)]);
        if (!from) return { ok: false, error: `I could not find ${fromQuery} on the map` };
        if (!to) return { ok: false, error: `I could not find ${toQuery} on the map` };

        if (!active) setActive(true);
        markers.clear();
        globe.setAutoRotate(false);
        statusBar.setTarget(`${from.name} → ${to.name}`, 'Plotting corridor...');

        const arc = globe.addArc?.(from.lat, from.lng, to.lat, to.lng);
        const separation = distanceKm(from.lat, from.lng, to.lat, to.lng);

        /* Frame both ends: back off in proportion to how far apart they are,
           or a long route leaves one end off-screen. */
        const midLat = (from.lat + to.lat) / 2;
        const midLng = Math.abs(from.lng - to.lng) > 180
            ? ((from.lng + to.lng) / 2 + 180)
            : (from.lng + to.lng) / 2;
        await globe.flyTo(midLat, midLng, {
            distance: cameraDistanceFor(separation * 1.6, globe.radius),
            ms: 2200
        });

        markers.addMarker({ lat: from.lat, lng: from.lng, label: labelFor(from.name, from.source), pin: true, boxed: true });
        markers.addMarker({ lat: to.lat, lng: to.lng, label: labelFor(to.name, to.source), pin: true, boxed: true });

        /* REAL ROUTE DATA FIRST, if a schedule provider is configured. This is
           the only source that knows an aircraft's origin and destination; the
           corridor below is a fallback that knows neither. Resolving the
           airports from coordinates rather than a name table is what makes
           "Delhi" find DEL and "Tokyo" find HND. */
        let scheduled = [];
        let fromAirport = null, toAirport = null;
        if (window.electronAPI?.aviation && airportIndex.length) {
            fromAirport = primaryAirport(airportIndex, from.lat, from.lng);
            toAirport = primaryAirport(airportIndex, to.lat, to.lng);
            if (fromAirport && toAirport) {
                const r = await window.electronAPI
                    .aviation('route', { from: fromAirport.iata, to: toAirport.iata })
                    .catch(() => null);
                if (r?.ok) {
                    scheduled = r.data.flights || [];
                    codeOverlay.log(`aviation.route(${fromAirport.iata} -> ${toAirport.iata}) -> ${scheduled.length} flights`);
                } else if (r?.reason && r.reason !== 'no-key') {
                    /* A quota that has run out is a different problem from a
                       route with no flights, and the user should hear which. */
                    statusBar.pushAlert(`Flight schedules unavailable — ${r.reason}`, 'alert');
                }
            }
        }

        const air = await feeds.flightsAlongRoute(from.lat, from.lng, to.lat, to.lng).catch(() => null);
        const flights = air?.ok ? air.flights : [];
        for (const f of flights.slice(0, 15)) {
            markers.addMarker({ lat: f.lat, lng: f.lng, label: f.callsign || 'AIRCRAFT', kind: 'flight' });
        }

        statusBar.setTarget(
            `${from.name} → ${to.name}`,
            scheduled.length
                ? `${Math.round(separation)} km · ${scheduled.length} scheduled flight${scheduled.length === 1 ? '' : 's'}`
                : `${Math.round(separation)} km · ${flights.length} aircraft over the corridor`
        );
        if (flights.length) {
            /* Stated on screen as well as spoken: the corridor is what is
               measured, not the route each aircraft is flying. */
            statusBar.pushAlert('Aircraft over the corridor — destinations not published by the open feed', 'alert');
        }
        codeOverlay.log(`showRoute(${from.name} -> ${to.name}) -> ${flights.length} aircraft, ${Math.round(separation)} km`);

        return {
            ok: true, from, to, distanceKm: separation, flights, arc: !!arc,
            scheduled, fromAirport, toAirport
        };
    }

    /* Driven from the existing animate(); this module never starts a loop. */
    function update(dt, audioEnergy) {
        if (!active) return;
        globe.update(dt, audioEnergy);
        satelliteLayer.update(dt);
        layerManager.update(dt);
        markers.update();
        labelRenderer.render(scene, camera);
    }

    function resize() {
        labelRenderer.setSize(window.innerWidth, window.innerHeight);
    }
    window.addEventListener('resize', resize);

    function dispose() {
        window.removeEventListener('resize', resize);
        feeds.stop();
        markers.dispose();
        globe.dispose();
        statusBar.dispose();
        codeOverlay.dispose();
        dossierPanel.dispose();
        layerPanel.dispose();
        layerManager.dispose();
        satelliteLayer.dispose();
        labelRenderer.domElement.remove();
    }

    return {
        setActive,
        toggle: () => setActive(!active),
        isActive: () => active,
        update, showLocation, showRoute, dispose,
        satellites: { toggle: setSatellites, service: satelliteService, layer: satelliteLayer },
        layers: layerManager,
        layerPanel,
        globe, markers, statusBar, codeOverlay, feeds, landmarks: landmarkService,
        /* SYNCHRONOUS, and that is the whole point: the intent parser runs on
           every utterance and cannot await a geocode to decide whether "show
           me X" was about a place. Asking the bundled gazetteer "is X a city
           you know?" is the honest way to tell "show me San Francisco" from
           "show me the model" — no keyword guessing, no network. */
        resolveLocal: (q) => findLocal(placeIndex, q),
        /* scripts.js checks this before lerping the camera at the mouse. */
        ownsCamera: () => active
    };
}

export default { createGlobeMode };
