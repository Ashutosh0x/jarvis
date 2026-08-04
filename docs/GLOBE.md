# Globe

The command-centre view. Press **F3**, or say *"show me San Francisco"*, and the
orb is replaced by a dark sphere with a glowing amber vector network — coastlines
and borders lit from within, a blue pin on the target, white labels on leader
lines, live seismic ripples.

```
show me Japan on map
show me Karnataka
take me to Tokyo
show me MG Road Bengaluru
show me what's happening in San Francisco
```

---

## Contents

- [Why vectors, not satellite imagery](#why-vectors-not-satellite-imagery)
- [It shares the orb's scene](#it-shares-the-orbs-scene)
- [Finding a place](#finding-a-place)
- [Framing is measured, not tabulated](#framing-is-measured-not-tabulated)
- [Labels](#labels)
- [Ground truth](#ground-truth)
- [Photographs](#photographs)
- [Live feeds](#live-feeds)
- [The Google key](#the-google-key)
- [What is deliberately not built](#what-is-deliberately-not-built)
- [Known limits](#known-limits)

---

## Why vectors, not satellite imagery

The obvious build is NASA Blue Marble on a sphere: about 16 MB of day, night,
cloud and bump textures. It was rejected on three counts.

**Offline.** 2.2 MB of Natural Earth GeoJSON ships in the repo and is public
domain. An 8K equirectangular texture is neither small nor free to redistribute
with confidence.

**Sharpness.** An 8K equirectangular is roughly 2 km per pixel at the equator.
At city zoom it is a blur. Vectors stay sharp at any distance because they are
lines, not samples.

**It is the look.** Photoreal reads as Google Earth. The amber-on-black vector
network is what the reference actually shows, and it is what a command centre
is supposed to look like.

Layers live in `static/geo/` — coastline, land, admin boundaries, populated
places. Every coastline segment is merged into **one** `LineSegments` buffer;
per-segment `THREE.Line` would be thousands of draw calls.

---

## It shares the orb's scene

`scripts.js` already owns a WebGL context, a camera and a `requestAnimationFrame`
loop. The globe is a `Group` inside **that** scene, hidden by default, driven
from **that** `animate()`. There is no second renderer.

A second renderer would mean two GL contexts, two loops, and two sets of GPU
buffers for a view only one of which is visible — on a 4 GB card that matters.

The camera is the one genuinely shared thing. The orb loop lerps it toward the
mouse every frame; `OrbitControls` wants to own it outright. Both writing to it
produces a camera that drifts while you drag. So `globeMode.ownsCamera()` is
read by `scripts.js` before it lerps, and the camera position is saved and
restored across the switch — F3 must be able to go back.

**Gotcha worth keeping:** `THREE.Clock.getElapsedTime()` calls `getDelta()`
internally, so a second `getDelta()` in the same frame returns ~0 and dt-scaled
auto-rotation never moves. Call `getDelta()` once, read `clock.elapsedTime`
after.

---

## Finding a place

Three tiers, cheapest first. Nothing is asked of the network that the disk can
answer.

### 1. The bundled gazetteer — `services/geocode.js`

About 1,250 populated places in 162 KB of Natural Earth data. Instant, free,
works on a train.

Speech-to-text is the real input, so matching is deliberately forgiving —
**and deliberately bounded**:

| Tier | Example | Score |
| --- | --- | --- |
| Exact | `san francisco` | 1.00 |
| Squashed | `sanfrancisco`, `newyork` | 0.95 |
| Prefix | `san fran` | 0.80 |
| Fuzzy | `san fransico` | 0.50–0.75 |

Two floors exist because without them the index invents places:

- **A prefix needs ≥ 4 characters and ≥ 50% coverage** (`isPrefixMatch`).
  Without it `map` prefix-matched **Maputo** and `ku` matched **Kuwait City**,
  both at 0.80 — the exact score the intent parser acts on. *"Show me the map"*
  flew the camera to Mozambique.
- **The edit budget scales with query length** (`allowedEdits`: 0 below 4
  characters, 1 below 6, else 2). A flat two edits let `map` reach *Malé* and
  `ku` reach *Baku*. Two edits on a three-letter word is a different word, not
  a typo.

### 2. Google Geocoding v4 — `googleMaps.js`

The gazetteer holds **cities only**. A country, a state, a street or a building
is not in it and never will be at 162 KB. Anything it cannot answer — or
answers without confidence — goes to Geocoding **v4**, which resolves all five
granularities in one call.

```
Japan               → country              span 3,331 km
Karnataka           → admin_area_level_1   span   766 km
Bengaluru           → locality
MG Road Bengaluru   → route                span     2 km
1600 Amphitheatre   → ROOFTOP
```

v4 endpoint: `geocode.googleapis.com/v4/geocode/address/{address}`, GET.
Field names are **lower camel case** (`addressComponents`, `formattedAddress`)
where v3 used snake case — that is the migration's main trap. v3 remains wired
as a fallback for a v4 outage or a v3-only quota uplift.

`languageCode=en` is sent because without it *Tokyo* returns as 日本、東京都 —
correct, and unreadable as a map label here.

The result is named at the granularity actually found. Preferring the locality
unconditionally labelled *"MG Road Bengaluru"* as plain **"Bengaluru"** —
correct about the city, useless as a label for what was asked.

### 3. Nominatim

Keyless OpenStreetMap fallback, used when there is no Google key. Reported as
`source: 'nominatim'` so the caller can say where the answer came from.

---

## Framing is measured, not tabulated

There is no table anywhere mapping *country → zoom 4*. Google's v4 response
carries a `viewport`, which is real data about the extent of the place. The
camera distance is derived from it:

```
spanKmFromViewport(viewport)   →  Japan 3,331 km · a street 2 km
cameraDistanceFor(spanKm)      →  continuous curve, clamped both ends
```

Continuous rather than bucketed, because a state and a small country differ by
degree, not in kind. Clamped because the globe carries no street-level geometry
— closer than the floor shows a blank sphere, further than the ceiling loses
the planet.

Longitude is narrowed by `cos(latitude)` when measuring the span, or Norway
looks wider than the equator.

The same measurement scales the landmark ring. Ten kilometres around *Japan*
finds one suburb of Tokyo and calls it the country.

---

## Labels

White uppercase on leader lines, drawn with `CSS2DRenderer` on a transparent,
click-through layer above the WebGL canvas — `pointer-events: none` on the
container and `auto` on the labels, or the overlay swallows the drag that is
supposed to rotate the globe.

### The tag names the source

The label suffix used to be the literal string `(WIRE)`, copied off the
reference footage. It meant nothing and was identical whether the coordinates
came from the gazetteer, Nominatim or Wikipedia — a constant dressed as data.

It now names the real provenance, or says nothing when provenance is unknown:

```
SAN FRANCISCO (NATURAL EARTH)
GOLDEN GATE BRIDGE (GOOGLE)
FISHERMAN'S WHARF (WIKIPEDIA)
```

### Thinning

Taking the five nearest results gives five labels from the same three blocks.
Flying to San Francisco returned Moscone Center, SFMOMA, Benu and the W — all
within a kilometre — and they printed on top of one another as one unreadable
smear.

`rankLandmarks` keeps the nearest, then skips anything within a separation
floor of a label already chosen, walking outward across the city instead. The
city pin is seeded as **taken**, because it is drawn outside that list and a
landmark landing on it prints both labels through each other.

Thinning is **not** allowed to fall back to the unthinned list when it comes up
short. An earlier version did, and in a dense downtown that fallback fired every
time and handed back exactly the stacked cluster it existed to prevent. Two
legible labels beat five printed on top of one another.

### Where landmarks come from

**Wikipedia geosearch is the default** — no key, no billing, no caching
prohibition, and it returns bridges, towers, stations and museums rather than
the restaurants that dominate a popularity-ranked Places search. `gsradius`
caps at 10 km.

Google Places (New) is wired and better, and is used when a key is present.

---

## Ground truth

When the camera arrives, a dossier of what is actually true there:

```
Delhi: 19:23 local · 28.6°C, light rain · 237 m elevation
       AQI 48 (Moderate) · street view 2012-11
```

Five calls issued in parallel via `Promise.allSettled` — elevation, time zone,
weather, air quality, Street View metadata. Sequential would be five chances to
stall the fly-to, and one dead endpoint must not withhold the four that
answered.

**Absent is not zero.** A field Google did not answer is omitted from the line
rather than printed as `0°C`. A genuine zero still prints — the guard is on
absence, not on falsiness. The dossier reports which parts did not answer and
why.

Local time is computed from the offset Google returned, not re-derived from the
zone id, so there is one source of truth rather than two that can disagree.

---

## Photographs

Real images of whatever was found — `services/placeImages.js`. Free sources
first, billed sources last, and **never a placeholder**.

| Kind of place | Chain |
| --- | --- |
| Country, state | Wikipedia → Wikimedia Commons → satellite |
| City | Wikipedia → Wikimedia Commons → Places |
| Landmark | Wikimedia → Places → Street View |
| Street, building | Wikimedia → Street View → Places |

A country is never sent to Places — *"Japan"* as a Places query returns a
restaurant. And a city is not mistaken for a country despite both returning
`APPROXIMATE`: the **type** separates them, not the granularity.

**Street View is always preceded by its metadata check.** Metadata is free and
says whether imagery exists; the image endpoint bills the same for a grey "no
imagery available" placeholder as for a photograph.

**Attribution is carried, not dropped.** Google's terms require
`authorAttributions`; Commons images are CC and require author and licence. An
image whose attribution did not survive the parse is not returned at all — and
an uncredited Places photo is never even fetched, so it is never billed either.

If no source has a picture, the result is an empty list and nothing is shown.
There is no stock-photo substitute and no grey tile pretending to be a place.

---

## Live feeds

**USGS earthquakes** ship on — public, no key, updated every few minutes. Events
at magnitude 4.5 and above draw an expanding amber ripple; ripple size follows
magnitude, because a M6 and a M2.5 rendered identically would make the display
decorative.

NASA FIRMS and OpenSky are registered as `configured: false` with a stated
reason rather than pretending to be off. A feed the user has not configured
that silently does nothing is the failure mode this project keeps deleting.

Offline is normal: a failed poll marks the feed stale and keeps the last good
data. It does not throw and it does not clear the globe.

---

## The Google key

Optional. Without it the globe runs on the bundled gazetteer, Nominatim,
Wikipedia and USGS — all keyless.

```bash
# .env  (gitignored)
GOOGLE_MAPS_API_KEY=...
```

Enable **Places API (New)**, **Geocoding API**, and whichever of Weather, Air
Quality, Pollen, Elevation, Time Zone and Street View you want. Note that
ticking an API in the key's *restriction list* is not the same as *enabling* it
on the project — they are separate screens, and only the second one stops the
403.

### The key never reaches the renderer

`GOOGLE_MAPS_API_KEY` is read in the main process by `googleMaps.js` and stays
there. The renderer sends a **method name** through the `google-maps` IPC
channel and receives data back. Method names are whitelisted — an unchecked
method string from the renderer would be an open proxy.

This is the rule the credential vault already enforces for every other secret,
and it matters more here because this renderer displays third-party content.

Two obligations come with switching Google on, both from their own
documentation:

- **The Google logo is required** when their place data is drawn on a map that
  is not theirs. The Jarvis globe is Natural Earth vectors, so that obligation
  lands on us.
- **Place content may not be cached** — only `place_id` is exempt. The Google
  path deliberately bypasses the cache rather than quietly breaking the terms.

Dossiers cache for 10 minutes and geocodes for 24 hours. Failures are never
cached, or one blip poisons a point forever. Nothing polls, retries in a loop,
or runs on a timer — calls happen when you ask for a place.

---

## What is deliberately not built

Each of these was considered and rejected with a reason, rather than left as a
stub that bills when someone finds it.

| Not built | Why |
| --- | --- |
| Photorealistic 3D Tiles | Would replace the amber vector design with Google Earth, and it is the most expensive SKU on the platform |
| Address Validation, Roads | Postal and fleet problems; the globe has no addresses to validate and no GPS trace to snap |
| Geolocation API | It is IP-based — it answered from Bengaluru on a machine that was not there |
| Solar buildingInsights | Per-rooftop panel economics; a different application |
| Teleport city images | The API is dead — it returns an HTML page, not JSON |

---

## Known limits

- **The fly-to can land off-target when driven through the typed-command
  path.** Called directly it is exact (dot product 1.000, held stable); through
  the intent router it has been observed 51–68° off. The world-space quaternion
  fix was necessary but is not sufficient, and the cause is not yet found.
- The bundled gazetteer has **Bengaluru** but not *Bangalore*, **New Delhi**
  but not *Delhi*, and no *Chennai*. Google resolves all of them; without a key
  those phrasings fall to Nominatim.
- Intent parsing is synchronous, so the gazetteer cannot be replaced by an
  async lookup in the parser itself. An explicit *"on map"* bypasses the
  gazetteer gate for this reason.
- Labels are thinned but not collision-tested against the viewport, so a very
  oblique camera angle can still overlap two leader lines.
