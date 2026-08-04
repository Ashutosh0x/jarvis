// Where the sun is, right now.
//
// PURE. No network, no data files, no dependencies — the sun's position is
// computable from the clock alone, which makes the day/night terminator the
// one live layer on this globe that works on a plane with the wifi off.
//
// ---------------------------------------------------------------------------
// THE ALGORITHM, AND WHY IT IS THIS ONE
//
// NOAA's solar position equations, the same set their Solar Calculator uses.
// They are accurate to well under a degree for any date within a few centuries
// of now, which is three orders of magnitude better than this needs: a
// terminator drawn on a 900-pixel globe resolves about 0.4 degrees per pixel.
//
// The simpler "declination = 23.44 * sin(day of year)" approximation that gets
// posted everywhere is wrong by up to 2.5 degrees, and — worse — it has no
// equation of time, so the terminator would sit up to 16 minutes of longitude
// (4 degrees) off through the year. On a globe that is a visibly crooked line
// through the poles, and it is the kind of error nobody notices until they
// check it against sunrise where they live.
//
// EVERYTHING IS IN UTC. Local time zones never enter the calculation; the
// subsolar longitude IS the relationship between UTC and the Earth's rotation.
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Julian day from a JS Date, in UTC. */
export function julianDay(date) {
    return date.getTime() / 86400000 + 2440587.5;
}

/** Julian centuries since J2000.0 — the time variable the NOAA series uses. */
export function julianCentury(date) {
    return (julianDay(date) - 2451545) / 36525;
}

/**
 * Solar declination and the equation of time.
 *
 * Declination is how far north or south the sun is overhead: it runs between
 * +23.44 at the June solstice and -23.44 at December, and is what makes the
 * terminator tilt across the seasons.
 *
 * The equation of time is the gap between clock noon and actual solar noon,
 * caused by the Earth's elliptical orbit and its axial tilt. It swings roughly
 * -14 to +16 minutes over a year. Leaving it out is the single largest error
 * in a naive terminator.
 *
 * @returns {{declination:number, equationOfTimeMinutes:number}} degrees, minutes
 */
export function solarParameters(date = new Date()) {
    const t = julianCentury(date);

    // Geometric mean longitude and anomaly of the sun.
    const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);

    // Equation of centre: the correction for the orbit not being circular.
    const C = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
        + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t)
        + Math.sin(3 * M * RAD) * 0.000289;

    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * t;
    const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

    // Obliquity of the ecliptic — the axial tilt, slowly decreasing.
    const e0 = 23 + (26 + ((21.448 - t * (46.815 + t * (0.00059 - t * 0.001813)))) / 60) / 60;
    const e = e0 + 0.00256 * Math.cos(omega * RAD);

    const declination = Math.asin(Math.sin(e * RAD) * Math.sin(appLong * RAD)) * DEG;

    // Equation of time, in minutes.
    const y = Math.tan((e / 2) * RAD) ** 2;
    const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const eqTime = 4 * DEG * (
        y * Math.sin(2 * L0 * RAD)
        - 2 * eccentricity * Math.sin(M * RAD)
        + 4 * eccentricity * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
        - 0.5 * y * y * Math.sin(4 * L0 * RAD)
        - 1.25 * eccentricity * eccentricity * Math.sin(2 * M * RAD)
    );

    return { declination, equationOfTimeMinutes: eqTime };
}

/**
 * The subsolar point: the one spot on Earth with the sun directly overhead.
 *
 * Latitude is simply the declination. Longitude is where solar noon currently
 * is, which is 15 degrees of rotation per hour away from the Greenwich
 * meridian, corrected by the equation of time.
 *
 * @returns {{lat:number, lng:number}} degrees, lng normalised to [-180, 180]
 */
export function subsolarPoint(date = new Date()) {
    const { declination, equationOfTimeMinutes } = solarParameters(date);

    const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes()
        + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;

    /* Solar noon happens at the longitude where true solar time is 12:00.
       Every minute past UTC noon moves that point 0.25 degrees west. */
    let lng = -((utcMinutes + equationOfTimeMinutes) / 4 - 180);

    lng = ((lng + 180) % 360 + 360) % 360 - 180;      // wrap into [-180, 180]
    return { lat: declination, lng };
}

/**
 * Unit vector from the Earth's centre toward the sun, in the same frame
 * globeRenderer's latLngToVector3 uses.
 *
 * Shares that frame deliberately: a separately-derived sun vector is how the
 * lit hemisphere ends up ninety degrees from where the terminator is drawn.
 */
export function sunDirection(date = new Date()) {
    const { lat, lng } = subsolarPoint(date);
    const phi = (90 - lat) * RAD;
    const theta = (lng + 180) * RAD;
    return {
        x: -Math.sin(phi) * Math.cos(theta),
        y: Math.cos(phi),
        z: Math.sin(phi) * Math.sin(theta)
    };
}

/**
 * Is it daytime at this point?
 *
 * @param {number} altitudeDeg  sun elevation counted as "day". 0 is the
 *   geometric horizon; -6 is civil twilight, which is when streetlights come
 *   on and is the more useful threshold for "is it dark here".
 */
export function isDaylight(lat, lng, date = new Date(), altitudeDeg = 0) {
    return solarAltitude(lat, lng, date) > altitudeDeg;
}

/** Sun elevation above the horizon at a point, in degrees. */
export function solarAltitude(lat, lng, date = new Date()) {
    const sub = subsolarPoint(date);
    /* Angular distance from the subsolar point, via the spherical law of
       cosines. Altitude is ninety degrees minus that distance. */
    const cosZenith = Math.sin(lat * RAD) * Math.sin(sub.lat * RAD)
        + Math.cos(lat * RAD) * Math.cos(sub.lat * RAD) * Math.cos((lng - sub.lng) * RAD);
    return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) * DEG;
}

export default { subsolarPoint, sunDirection, solarParameters, solarAltitude, isDaylight, julianDay, julianCentury };
