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
- [Themes](#themes)
- [Layers, and the switchboard](#layers-and-the-switchboard)
- [Satellites](#satellites)
- [Aurora](#aurora)
- [Cameras](#cameras)
- [Environment — volcanoes, storms and ice](#environment--volcanoes-storms-and-ice)
- [Companies](#companies)
- [Shapes, from OpenStreetMap](#shapes-from-openstreetmap)
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

## Themes

Three of them, cycled with **T**: **amber** (the default), **ghost** (violet),
**tactical** (blue).

The interesting part is not the palette, it is that the globe's colour lives in
three unrelated systems — a uniform on the atmosphere shader, the materials on
the merged coastline and border buffers, and a CSS variable the HUD panels read.
A theme is only coherent if all three move together, so one manager owns the
mapping and pushes to each rather than each system carrying its own default.

`GLOBE_COLORS` is **mutated**, not just read. A layer created *after* a theme
change reads that object for its colours, so without the mutation a satellite
switched on under the violet theme would be born amber — correct at startup and
wrong forever after. `dispose()` restores amber so the HUD variable does not
stay violet once the orb is back.

The colour logic is guarded against a missing `document` so it stays testable in
node. The first version threw `document is not defined` in the suite, which is
exactly the class of renderer assumption a test is for.

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

## Environment — volcanoes, storms and ice

NASA's EONET feed, keyless, drawing the events USGS and FIRMS do not: volcanoes,
severe storms, sea and lake ice, floods, landslides. Diamond markers, coloured
per category so they read as distinct from the round satellite dots and the
seismic ripples.

**It deliberately does not fetch everything.** EONET's open feed is about 7,000
events and roughly 6,950 of them are wildfires — the exact thing the FIRMS layer
already draws, from a feed with better coverage. Pulling the whole feed would
bury the globe under a duplicate of a layer that already exists, so this
requests only the categories Jarvis does not already have. Verified live: 67
events, 32 volcanoes, 33 ice, 2 storms, no wildfires leaked.

Two parsing details a test pins, because both are silent when wrong:

- **EONET coordinates are `[lng, lat]`** — GeoJSON order. Read the other way, a
  Pacific typhoon draws in the Sahara.
- **A storm is a track, not a point.** The feed carries every recorded position;
  the **last** one is where the storm is now. Taking the first draws a hurricane
  where it made landfall days ago.

One request per category, settled in parallel so a single failing category does
not lose the rest, cached 30 minutes through the layer registry.

---

## Companies

Two different things share one name here, and they answer different questions.

### 1. The ranking — 11,222 companies, at their head offices

Switch the **Companies** layer on and the world's public companies appear where
their head offices actually are, sized by market capitalisation and coloured by
the day's move — green up, red down, amber flat, grey when the feed has no
number rather than a fake zero.

This is a **local database**, not a live dependency. Two crawls paid for once:

| Step | Script | Cost | Result |
| --- | --- | --- | --- |
| The ranking | `scripts/fetch-ranking.mjs` | 113 credits | 11,222 companies, 81 countries, with rank, ticker, market cap, price and today's move |
| The head offices | `scripts/resolve-hq.mjs` | 14,144 Places lookups, ≈ $453 | 10,995 resolved coordinates |

Both land in `data/`, both are read with `fs` at startup, and both work offline.
The globe **must** prefer them over resolving live — a launch that re-buys
eleven thousand lookups already sitting in a file is the single most expensive
mistake this feature could make. Live resolution remains only as the fallback
for a machine that has never run the resolver.

### Validation is the point, not a bonus

A coordinate that is merely plausible is worse than no coordinate: it puts a
real company at a real place that is the wrong place, and nothing downstream can
tell. Every lookup has to pass two checks before it is kept.

- **Country.** The ISO country on the result must equal the country the ranking
  recorded. This is what stops *Reliance* — ticker `RS`, an American steel
  distributor — being pinned to Mumbai. Google ranks the Indian conglomerate
  first for that name regardless of region bias, and only the returned country
  code exposes it.
- **Name.** The matched place must share a meaningful token with the company
  name. Google answers *"Dow"* with *"Dow Chemical Co"* (good) and sometimes
  with a name having nothing in common (not good). Token overlap catches the
  second without demanding an exact match that legal suffixes and local
  spellings would break.

A result failing either check is **recorded as rejected with its reason**, not
silently dropped and not quietly kept. The rejects are the audit trail:

```
10,995 resolved      10,959 building-level (Places) · 36 city-level (Wikidata)
   226 rejected      106 name mismatch · 78 no candidates · 42 wrong country
```

Confidence travels with each row — 10,116 high, 429 medium, 450 low — so a
caller that wants only the verified ones filters on `confidence` instead of
trusting a number it cannot inspect.

The crawl is **resumable and budgeted**, because a $453 script that is not both
is a script that spends the money twice. Every result is written as it lands,
keyed by ticker, so a crash at company 9,000 does not re-buy 9,000 lookups.
Negative results are cached too, or every rerun re-buys every failure forever.
`--max-lookups` defaults to 200 rather than "all", because the expensive default
is the one that gets run by accident, and the spend so far is printed in dollars
as it goes.

### Click one

A green dot opens a card: name, ticker, rank, price, today's move, address — all
of it already carried on the marker, so the card costs nothing to open — and a
photograph of the office, fetched on demand.

**On demand is the whole design.** A photograph is two billed Google requests,
Details for the reference and media for the bytes, so sweeping all 10,959 would
be roughly $263 and 877 MB of pictures nobody asked for. One click is about half
a cent. The second click on the same company is free: photos are cached to
**disk**, not memory, because they are large, they never change, and a cache
that empties on restart re-buys them every launch. Misses are cached too — a
place with no photo has no photo tomorrow either.

### 2. Companies at a place — live, from Places

The other question is *"what companies are here"*, and no baked list can answer
it. Fly anywhere with the layer on, or ask:

```
show me AI companies in San Francisco
find fintech companies in London
show software companies in Bengaluru
```

Nothing is hardcoded. The query is biased to the target's coordinates through
Places Text Search `locationBias`, and **the bias radius scales with the place**
so a country is not searched as a 5 km circle around its centroid. Verified live
across three continents — 39 / 34 / 33 real companies, every one with a website,
the Tokyo results correctly keeping 株式会社.

**Why this replaced the spreadsheet.** The original design was a 5,000-row CSV of
"verified" companies for eight Indian cities, baked into the globe. That is
stale the day it is written, answers only its eight cities, and is unverifiable
— a model generating "5,000 verified companies" is precisely the fabrication
this project forbids. A coordinate-biased live search answers any company type
at any place, and every row is real because it came from the API at the moment
it was asked.

**The corporate-suffix filter fails safe.** `looksLikeCompany` keeps incorporated
entities — Pvt Ltd, LLC, Inc, Ltd, GmbH, Pte, PLC — the trading words
(Technologies, Systems, Solutions), and anything Google typed as a
`corporate_office`; it drops the hotels, malls and civic buildings a business
search drags in. An unsuffixed campus like *"Bosch Adugodi"* is occasionally
missed, but a hotel is never shown as a company. 11/13 on the real Bengaluru
noise, every miss in the safe direction. Catching the branded campuses would
need a hardcoded name list, which is the thing this feature exists to avoid.

**Sixty is Google's ceiling, and the reply says so.** Places Text Search returns
at most 60 results per query — three pages of twenty — and no parameter lifts it.
Verified live at 52 for *"software"* and 55 for *"tech"* in Bengaluru. "All"
therefore means all that the query returns, which is the honest most a single
search can give. The reply says *"N on the map"*, never *"all N companies in
Bengaluru"*.

Every company is a dot; only a spread-out subset of about fourteen is **named**,
with the level-of-detail fade bringing more names within reach as you zoom.
Sixty leader-line labels in one city smear into an unreadable mass — the dots
carry the full set, the labels stay legible.

The layer is **off by default**, because each navigation with it on is a billed
Places search. Company markers are tracked separately and removed on their own,
so switching the layer off does not wipe the landmark ring.

### The key is metered, and stays in main

`PARSE_API_KEY` (CompaniesMarketCap via parse.bot) is read in the main process by
`companiesMarketCap.js` and never crosses the bridge, the same rule as
`googleMaps.js`. One uncached call is one credit, so nothing in that module
loops over pages on its own: `ranking()` takes an explicit page, and a caller
wanting ten pages has to ask for ten. Successes are cached to disk for twelve
hours — market caps move daily, not secondly. **Failures are never cached**,
because a failure was not charged, and caching it would hide a transient problem
for half a day.

Status is passed through rather than flattened: `402` is out of credits, `401`
and `403` are a bad key, `429` is a rate limit. None of those is "offline", and
telling them apart is what lets someone act on it.

---

## Shapes, from OpenStreetMap

Google Places is a search engine and a good one — ask it for tech parks in
Bengaluru and it finds them. What it returns is a **point**. Manyata Tech Park,
a 120-hectare campus with fifty buildings, arrives as one pin the same size as a
coffee shop.

OpenStreetMap has the same campus as a polygon with its real boundary, tagged
`landuse=commercial` — a machine-readable fact about what it *is*, rather than a
guess from its name. So Google finds it and OSM shapes it.

**Nominatim, not Overpass.** Overpass is the natural tool for "everything with
this tag in this box" and was the first choice. Four endpoints were probed —
`overpass-api.de`, `kumi.systems`, `private.coffee` and `osm.jp` — and all four
returned 504 or timed out. It is a free shared service with no availability
guarantee, and a globe that goes blank when a volunteer server is busy is not a
globe. Nominatim answered every request in the same window and returns `geojson`
polygons directly, so the feature is built on the endpoint that stays up.

**The rate limit is enforced in code, not in a comment.** Nominatim's usage
policy is one request per second from a single source with an identifying
User-Agent, and exceeding it gets the app blocked — which is indistinguishable,
to a user, from being broken. A serialised queue holds the interval, so a burst
of twenty lookups becomes twenty seconds of polite traffic rather than twenty
simultaneous requests and a ban. The limit does not depend on every future
caller remembering it.

The coordinates are used as a **viewbox, not as the query**: the name alone
finds the Manyata Tech Park in the wrong city, and the coordinate alone finds
whatever building is nearest. Bounding the search to a box around the point
Google already returned is what makes the two agree on the same object. The box
is narrowed by `cos(latitude)`, or a fixed degree box is a 3 km search at the
equator and a 300 km one in Norway.

Absence of geometry is reported as `geometry: null`, never faked by drawing a
circle and calling it a campus. This layer is keyless, so a campus boundary does
not depend on anyone's billing account.

---

## Live feeds

| Feed | Key | Interval | Ships on |
| --- | --- | --- | --- |
| USGS earthquakes | none | 5 min | ✅ |
| OpenSky flights | none | 15 min | ✅ |
| Satellites (CelesTrak) | none | 2 h elements | ✅ |
| Aurora / Kp (NOAA) | none | 15 min | ✅ |
| Road cameras (TfL, LTA) | none | on demand | ✅ |
| NASA EONET environment | none | 30 min | ✅ |
| Company head offices | none — crawled to `data/` | static | ✅ |
| OSM shapes (Nominatim) | none | on demand | ✅ |
| Windy webcams | free key | on demand | needs key |
| NASA FIRMS wildfires | free MAP_KEY | 30 min | needs key |
| Companies at a place (Places) | Google | on demand | needs key |
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
PARSE_API_KEY=...        # optional: CompaniesMarketCap, metered per call
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
- **The company ranking is a snapshot, and it says when it was taken.** Prices
  and market caps come from the crawl of 5 Aug 2026, not from a live quote. The
  head offices age far more slowly than the numbers do; re-run
  `scripts/fetch-ranking.mjs` for fresh figures, and note it costs credits.
- 226 of the 11,222 companies have **no** coordinate, because the resolver
  refused to guess one. They are absent from the globe rather than approximated,
  and `data/companies-hq.json` records which and why.
- The two company answers are different questions and are not merged. The
  crawled layer knows where *NVIDIA* is headquartered; it does not know what is
  in an office park in Pune. The Places search answers the second and knows
  nothing about market capitalisation.
