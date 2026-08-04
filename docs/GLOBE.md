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

## Layers, and the switchboard

Everything the globe draws is a **layer** in one registry (`globeLayers.js`),
and every layer can be switched on or off from a glass panel — press **L**.

The registry exists because the alternative did not scale. Each early feed —
quakes, fires, flights, events — was wired into `globeMode` by hand: its own
field, its own visibility check, its own line in the update loop and in
teardown. That works at five and collapses at fifteen, and it left the user
unable to turn any of them off. A layer now registers one object and gets
polling, visibility, per-frame updates and disposal for free.

Two properties are load-bearing:

- **An off layer costs nothing.** Polling runs only while a layer is visible
  and the per-frame update skips the rest — switching a layer off stops the
  work, it does not merely hide the result. And feed visibility is *real*: a
  hidden feed contributes nothing to the ticker, the ripples or proximity
  search, not just to the drawing.
- **A layer that refuses to switch on leaves the switch off.** Satellites load
  their elements lazily and the load can fail; a panel showing "on" over an
  empty sky would be a lie about what is drawn. The panel keeps no state of its
  own and re-renders from the registry, so it cannot drift from reality.

The poll guard is a `Set`, not a flag per layer — a fetch slower than its own
interval is skipped rather than stacked, and the id clears in a `finally` so a
thrown fetch cannot wedge a layer permanently off.

---

## Satellites

Real objects, propagated to where they are **right now** — say *"show me the
satellites"* or *"track the ISS"*, or switch the layer on in the panel.

A TLE is not a position. It is a set of orbital elements valid at an epoch, and
turning it into "where is the ISS now" means running **SGP4**, the model NORAD
publishes the elements for (`satellite.js`, pinned to 6.0.2 — the 7.x line
ships a WASM build whose top-level `await` breaks the app's IIFE bundle).
Drawing a satellite at its epoch sub-point instead is wrong by thousands of
kilometres within minutes: the ISS covers ~7.7 km every second.

Verified against live CelesTrak data — the ISS resolves at ~423 km altitude and
moves ~415 km of ground track per minute, which is what an orbit at that height
does. Elements are cached two hours (CelesTrak's guidance); positions are
propagated locally every frame from that one download. Altitude is exaggerated
4× and the constant is named, because true-scale LEO sits 6% above the surface
and reads as touching it — orbit *order* is preserved so LEO still sits below
GPS. The whole set is one `InstancedMesh`; the ISS gets a larger marker and a
92-minute ground track.

---

## Aurora

The geomagnetic oval, drawn when a storm is actually underway — NOAA's
planetary Kp index, keyless, polled every 15 minutes.

**Nothing is drawn below Kp 4.** An oval painted during quiet conditions is
decoration; below the threshold the layer reports the reading and draws no ring.
When it does draw, the ring is centred on the **geomagnetic** pole (~80.6°N
72.6°W, over northern Greenland), not the spin axis — a ring around the
geographic pole sits symmetrically over Siberia and Canada, which is visibly
wrong to anyone who has seen a forecast map. Its radius follows the standard
equatorward-boundary rule: ~24° from the pole when quiet, ~2° further per Kp
step. Storm alerts (Kp ≥ 5) fire once per level change, not once per poll.

The solar-wind plasma feed named in most guides
(`products/solar-wind/plasma-5-minute.json`) answers 404, so this ships on the
Kp index alone rather than guessing at a replacement path.

---

## Cameras

Live public webcams near the target, frameless under the globe — say *"show
traffic cameras"*, or just fly somewhere and the nearest views appear.

Three sources, all published for public viewing:

| Source | Key | Coverage |
| --- | --- | --- |
| Transport for London JamCams | none | ~780 London road cameras |
| Singapore LTA | none | expressway cameras |
| Windy webcams | free key | ~70,000 opt-in webcams worldwide |

**What this is not.** These are government congestion cameras pointed at roads
and owner-submitted webcams — feeds their operators *chose* to publish. Nothing
here scans for unsecured IP cameras or anything aimed at people or private
property. When a place has no public camera the answer is "no cameras here"; it
does not then go hunting private ones.

**The renderer never touches a camera host.** Every frame is fetched in the
main process and handed over as a data URI. A camera URL is an arbitrary remote
origin chosen from a feed this app did not write; pointing an `<img>` at it from
a page holding the user's session is precisely the exposure to avoid. Two guards
enforce it, both tested: the host is checked on its **parsed hostname** (a
substring test would wave `tfl.gov.uk.evil.com` through), and a URL must be one
this process actually handed out — an allowed host is not enough.

Windy is queried per-location rather than pre-listed: it has no global list and
its image URLs are token-signed, expiring in 10 minutes, so caching them would
serve dead links. Set `WINDY_WEBCAMS_API_KEY` to light up the world; without it
the two government feeds still cover London and Singapore. It refreshes on a
timer — these are stills on the operator's schedule, not a live stream, and the
caption says so rather than implying a liveness the source lacks.

---

## Live feeds

| Feed | Key | Interval | Ships on |
| --- | --- | --- | --- |
| USGS earthquakes | none | 5 min | ✅ |
| OpenSky flights | none | 15 min | ✅ |
| Satellites (CelesTrak) | none | 2 h elements | ✅ |
| Aurora / Kp (NOAA) | none | 15 min | ✅ |
| Road cameras (TfL, LTA) | none | on demand | ✅ |
| Windy webcams | free key | on demand | needs key |
| NASA FIRMS wildfires | free MAP_KEY | 30 min | needs key |
| Luma events | Luma Plus | 10 min | needs key |

**USGS earthquakes** need nothing at all. Magnitude 4.5 and above draws an
expanding amber ripple, sized by magnitude — a M6 and a M2.5 rendered
identically would make the display decorative.

**OpenSky** is genuinely keyless, but the quota is not generous: anonymous
access is on the order of a hundred requests a day. The unbounded
`states/all` response is also ~920 KB. Polling it every 30 seconds — as an
earlier version did — is 2,880 requests and gigabytes a day, and gets
rate-limited within the hour. Fifteen minutes is 96 requests a day and well
inside the budget.

**NASA FIRMS requires a MAP_KEY** and the path is positional:

```
/api/area/csv/{MAP_KEY}/{SOURCE}/{AREA}/{DAY_RANGE}
```

Omit the key and every segment shifts along — the source is read as the key,
the area as the source — and all four parameters fail at once. Worse, FIRMS
answers **HTTP 200** with a plain-text complaint, so a status-code check passes
and the feed reports itself live with zero detections forever. The parser
therefore inspects the body, not the status.

**Luma events** are covered in their own section below.

### Aircraft, and what "flights from A to B" can honestly mean

```
what is flying over Tokyo
show me flights from Bengaluru to Delhi
```

Flying to a city fetches aircraft **on demand** in a bounding box around it,
rather than reading the 15-minute ambient poll. That is not a micro-optimisation:
an airliner covers about 225 km in fifteen minutes, so a pin drawn from the last
poll can be a quarter of the way to another country. The panel prints the
snapshot age for the same reason — a position without a stated age claims a
precision the feed cannot support.

A route draws a **great-circle arc**, which is the path aircraft actually fly,
and lists the aircraft over that corridor now.

**It does not claim those aircraft are travelling between the two cities**, and
it cannot. OpenSky's state vectors carry callsign, position, altitude, heading
and speed — no origin, no destination. Its `flights/departure` endpoint does
report an airport pair, but on anonymous access it is unusable for this:

- a 24-hour window answers `403 "You cannot access historical flights"`
- inside the ~2-hour window that IS allowed, `estArrivalAirport` was null for
  **10 of 10** departures measured from Bengaluru — OpenSky only estimates the
  arrival once the aircraft has landed

So Jarvis says how many aircraft are over the corridor, and says out loud that
it cannot confirm their destinations. Some of them are simply crossing.

A feed with no credentials reports `configured: false` with the reason and
**never polls**. Retrying a request that is structurally incapable of
succeeding is how a dead feed comes to look like a flaky network.

Offline is normal: a failed poll marks the feed stale and keeps the last good
data. It does not throw and it does not clear the globe.

---

## Luma events

Events from a Luma calendar appear as magenta markers, with cover image, time
and venue in the dossier panel.

```
what events are happening in Tokyo
show me events in San Francisco
```

### It is YOUR calendar, not the world's

This is the part worth reading before expecting a global events layer.

Luma's public API has **66 endpoints and not one of them searches**. Verified
against the live OpenAPI document at `public-api.luma.com/openapi.json` — there
is no `/search`, `/discover`, `/explore` or `/browse` path. Their documentation
is explicit:

> "API keys are scoped to a single calendar. Each calendar you want to manage
> via the API needs its own key, and each key only grants access to the calendar
> it was created on."

So *"show me every AI meetup in Tokyo"* cannot be answered by this API at any
price. What can be answered is *"show me my events, wherever in the world they
are"*, and that is what this does. The feed is named **"Luma (my calendar)"**
for that reason: a layer that shows one calendar while implying it shows
everything is worse than no layer.

Scraping the public Discover feed is not an alternative. Luma's Terms of Use:

> "You must not access the Service by any means other than our publicly
> supported interfaces."

This is an industry pattern rather than a Luma quirk — Eventbrite removed its
public event search in December 2019 and never replaced it. The catalogue *is*
the product.

### The key never crosses the bridge

`LUMA_API_KEY` grants full write access to the calendar it belongs to: it can
create events, cancel them, and read the guest list with every attendee's email
address. It is read in the main process by `lumaEvents.js` and stays there.

The IPC whitelist is **read-only** — `listEvents`, `getEvent`, `calendar`,
`status`. The write half of the API is deliberately unreachable from the
renderer, because a bug in a map layer must not be able to cancel an event.

### Details worth knowing

- Only events with a `coordinate` can be pinned. Luma documents that field as
  null for online events and for addresses it could not geocode, so an
  online-only calendar legitimately produces zero markers — and the feed says
  `live (N events, none with coordinates)` rather than reporting a failure.
- Times render in the **event's** timezone. An 18:00 event in Tokyo must not
  read as 09:00 because the desk is in London.
- "No events near there" is only ever said when the feed is actually working.
  With no key the answer is that no calendar is connected — claiming a city has
  no events, on the evidence of a missing API key, is a statement about the
  world drawn from a configuration gap.
- Rate limit is 200 requests/minute per calendar. This polls every 10 minutes,
  caches for 10, and caps pagination at 5 pages.

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
