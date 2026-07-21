// Prediction market parsing and odds math.
//
// Fixtures are REAL payloads captured from both APIs on 21 Jul 2026. That
// matters here more than usual, because three details are silent and wrong
// assumptions about them are not small errors:
//
//   * Polymarket sends outcomes/prices as JSON STRINGS, not arrays.
//   * Kalshi sends DOLLAR STRINGS ("0.0120" = 1.2%). An earlier draft of the
//     module — and my own first assumption — treated these as integer cents,
//     which reports a 1% market as certain.
//   * Kalshi volumes live on *_fp fields, also strings.

import {
    impliedToDecimal, decimalToImplied, impliedToAmerican, americanToImplied, formatOdds,
    expectedValue, kellyFraction, impliedVig,
    parsePolymarketEvent, parsePolymarketMarket, parsePolymarketBook,
    parseKalshiEvent, parseKalshiMarket,
    titleSimilarity, matchMarkets, checkProbAlerts,
    formatVolume, formatProb, timeUntil, resolveCategory, PREDICTION_CATEGORIES,
    describeMarket, describeTrending, describeComparison,
} from '../predictionMarkets.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const near = (a, b, eps = 1e-9) => a !== null && Math.abs(a - b) < eps;

/* --- captured fixtures ----------------------------------------------------- */

// Polymarket: gamma /events, real shape (prices are strings inside strings)
const POLY_EVENT = {
    id: '12345',
    ticker: 'fed-decision-july',
    slug: 'fed-decision-in-july',
    title: 'Fed Decision in July?',
    endDate: '2026-07-30T04:00:00Z',
    volume: 4102637.42,
    volume24hr: 1080000,
    liquidity: 250000.5,
    closed: false,
    markets: [
        {
            id: 'm1', conditionId: '0xabc', question: 'No change in Fed interest rates after July 2026 meeting?',
            outcomes: '["Yes", "No"]', outcomePrices: '["0.874", "0.126"]',
            volume: '1080000', liquidity: '120000', closed: false,
            clobTokenIds: '["1062296681027161498", "8890234098234098234"]',
        },
        {
            id: 'm2', conditionId: '0xdef', question: '25+ bps increase after July 2026 meeting?',
            outcomes: '["Yes", "No"]', outcomePrices: '["0.117", "0.883"]',
            volume: '1040000', closed: false, clobTokenIds: '[]',
        },
    ],
};

// Kalshi: /markets, real field names and dollar-string values
const KALSHI_MARKET = {
    ticker: 'KXFEDDECISION-26JUL-NC',
    event_ticker: 'KXFEDDECISION-26JUL',
    title: 'No change in Fed interest rates after the July meeting?',
    status: 'active',
    close_time: '2026-07-30T18:00:00Z',
    yes_bid_dollars: '0.8600', yes_ask_dollars: '0.8800',
    no_bid_dollars: '0.1200', no_ask_dollars: '0.1400',
    last_price_dollars: '0.8700',
    volume_fp: '482000.00', volume_24h_fp: '91000.00', open_interest_fp: '210500.00',
    liquidity_dollars: '18000.0000',
    rules_primary: 'Resolves Yes if the target range is unchanged.',
};

// The genuinely thin market from the live probe: a one-sided book at 1.2 cents.
const KALSHI_THIN = {
    ticker: 'KXMVESPORTS-XYZ', event_ticker: 'KXMVESPORTS', title: 'yes Philadelphia,yes Cleveland',
    status: 'active', yes_bid_dollars: '0.0000', yes_ask_dollars: '0.0120',
    no_bid_dollars: '0.9880', no_ask_dollars: '1.0000', last_price_dollars: '0.0000',
    volume_fp: '0.00', open_interest_fp: '0.00', liquidity_dollars: '0.0000',
};

/* --- the 100x trap --------------------------------------------------------- */
{
    const m = parseKalshiMarket(KALSHI_MARKET);
    check('kalshi: dollar strings are NOT divided by 100', near(m.probability, 0.87, 1e-6), `${m.probability}`);
    check('kalshi: a 87% market reads as 87%, not 8700%', formatProb(m.probability) === '87%', formatProb(m.probability));
    const thin = parseKalshiMarket(KALSHI_THIN);
    check('kalshi: a 1.2 cent market is 1%, not certain', formatProb(thin.probability) === '1%', formatProb(thin.probability));
    check('kalshi: volume comes off the _fp field', m.volume === 482000, `${m.volume}`);
    check('kalshi: open interest parsed', m.openInterest === 210500);
    check('kalshi: ticker and event ticker kept', m.ticker === 'KXFEDDECISION-26JUL-NC' && m.eventTicker === 'KXFEDDECISION-26JUL');
}

/* --- which price was used, and saying so ----------------------------------- */
{
    const twoSided = parseKalshiMarket(KALSHI_MARKET);
    check('kalshi: two-sided book uses the mid', near(twoSided.probability, 0.87, 1e-6) && twoSided.priceSource === 'book-mid');

    const lastOnly = parseKalshiMarket({ ...KALSHI_MARKET, yes_bid_dollars: '0.0000', yes_ask_dollars: '0.0000', last_price_dollars: '0.6500' });
    check('kalshi: with no book, the last trade is used AND flagged',
        near(lastOnly.probability, 0.65, 1e-6) && lastOnly.priceSource === 'last-trade');
    check('kalshi: a last-trade price is spoken as such',
        /last trade rather than a live quote/.test(describeMarket(lastOnly)));

    const oneSided = parseKalshiMarket(KALSHI_THIN);
    check('kalshi: a one-sided book is flagged, not presented as a mid', oneSided.priceSource === 'one-sided-book');

    const dead = parseKalshiMarket({ ticker: 'X', title: 'Nothing', yes_bid_dollars: '0.0000', yes_ask_dollars: '0.0000', last_price_dollars: '0.0000' });
    check('kalshi: no quote at all yields null, never 0%', dead.probability === null);
    check('kalshi: and is spoken as having no quote', /no live quote/.test(describeMarket(dead)));
}

/* --- Polymarket JSON-string fields ----------------------------------------- */
{
    const m = parsePolymarketMarket(POLY_EVENT.markets[0]);
    check('poly: outcomes parsed out of a JSON string', m.outcomes.length === 2 && m.outcomes[0].name === 'Yes');
    check('poly: prices parsed out of a JSON string', near(m.outcomes[0].price, 0.874));
    check('poly: the favourite is identified', m.topOutcome.name === 'Yes' && near(m.probability, 0.874));
    check('poly: token ids parsed for orderbook lookups', m.tokenIds.length === 2);
    check('poly: numeric strings converted', m.volume === 1080000);

    const broken = parsePolymarketMarket({ id: 'x', question: 'q', outcomes: 'not json', outcomePrices: '[[[' });
    check('poly: unparseable fields yield no outcomes, not garbage', broken.outcomes.length === 0 && broken.probability === null);

    const ev = parsePolymarketEvent(POLY_EVENT);
    check('poly: event parses its nested markets', ev.markets.length === 2);
    check('poly: event headline probability is its leading market', near(ev.probability, 0.874));
    check('poly: 24h volume kept separately from total', ev.volume24hr === 1080000 && ev.volume === 4102637.42);
}

/* --- THE INVERSION BUG -----------------------------------------------------
   Caught by live data, not by these fixtures: an unlikely binary market was
   reported as near-certain because the parser took the highest-priced outcome
   rather than the Yes leg. "Japan recession in 2026?" displayed 10% and was
   SPOKEN as "91% yes". These lock the meaning down. */
{
    const unlikely = parsePolymarketMarket({
        id: 'u1', question: 'Japan recession in 2026?',
        outcomes: '["Yes", "No"]', outcomePrices: '["0.10", "0.90"]', volume: '3400',
    });
    check('binary: probability is the YES leg, not the bigger number',
        near(unlikely.probability, 0.10), `${unlikely.probability}`);
    check('binary: an unlikely market is not spoken as near-certain',
        /at 10% yes/.test(describeMarket(unlikely)), describeMarket(unlikely).slice(0, 70));
    check('binary: flagged as binary', unlikely.isBinary === true);
    check('binary: the yes price is kept explicitly', near(unlikely.yesPrice, 0.10));

    const likely = parsePolymarketMarket({
        id: 'u2', question: 'Fed holds in July?',
        outcomes: '["Yes", "No"]', outcomePrices: '["0.874", "0.126"]',
    });
    check('binary: a likely market still reads correctly', near(likely.probability, 0.874));

    // Multi-outcome has no Yes leg, so the favourite is the meaningful figure.
    const multi = parsePolymarketMarket({
        id: 'u3', question: 'Ballon d\'Or 2026',
        outcomes: '["Mbappé", "Haaland", "Yamal"]', outcomePrices: '["0.106", "0.32", "0.18"]',
    });
    check('multi-outcome: falls back to the favourite', near(multi.probability, 0.32));
    check('multi-outcome: not flagged binary', multi.isBinary === false);

    // The event level had the same defect and the same fix.
    const ev = parsePolymarketEvent({
        id: 'e1', title: 'Bitcoin price in July',
        markets: [
            { id: 'a', question: 'Bitcoin above 100k?', outcomes: '["Yes","No"]', outcomePrices: '["0.02","0.98"]' },
            { id: 'b', question: 'Bitcoin above 70k?', outcomes: '["Yes","No"]', outcomePrices: '["0.35","0.65"]' },
        ],
    });
    check('event: headline is the leading YES, never a No leg', near(ev.probability, 0.35), `${ev.probability}`);
}

/* --- titles reaching the speaker ------------------------------------------- */
{
    const m = parseKalshiMarket({
        ticker: 'T1', title: 'Will the **high temp in Philadelphia** be <82° on Jul 22?',
        yes_bid_dollars: '0.4000', yes_ask_dollars: '0.4200', last_price_dollars: '0.4100',
    });
    const said = describeMarket(m);
    check('title: markdown asterisks are not spoken', !said.includes('**'), said.slice(0, 70));
    check('title: a comparison symbol becomes a word', /below 82/.test(said), said.slice(0, 80));
}

/* --- orderbook ------------------------------------------------------------- */
{
    const book = parsePolymarketBook({
        bids: [{ price: '0.85', size: '100' }, { price: '0.86', size: '250' }],
        asks: [{ price: '0.89', size: '400' }, { price: '0.88', size: '120' }],
    });
    check('book: best bid is the highest bid regardless of order', near(book.bestBid, 0.86));
    check('book: best ask is the lowest ask regardless of order', near(book.bestAsk, 0.88));
    check('book: spread computed', near(book.spread, 0.02, 1e-9));
    check('book: mid is the probability', near(book.probability, 0.87));
    check('book: an empty book yields nulls, not zeros',
        parsePolymarketBook({ bids: [], asks: [] }).bestBid === null);
}

/* --- odds conversion round trips ------------------------------------------- */
{
    check('odds: 50% is decimal 2.0', near(impliedToDecimal(0.5), 2));
    check('odds: decimal round trip', near(decimalToImplied(impliedToDecimal(0.25)), 0.25, 1e-12));
    check('odds: 25% is +300 American', Math.round(impliedToAmerican(0.25)) === 300);
    check('odds: 80% is -400 American', Math.round(impliedToAmerican(0.8)) === -400);
    check('odds: American round trip', near(americanToImplied(impliedToAmerican(0.65)), 0.65, 1e-12));
    check('odds: formatted American carries its sign', formatOdds(0.25, 'american') === '+300' && formatOdds(0.8, 'american') === '-400');
    check('odds: certainties are refused rather than dividing by zero',
        impliedToDecimal(0) === null && impliedToDecimal(1) === null && impliedToAmerican(1) === null);
    check('odds: junk input yields null', impliedToDecimal('abc') === null && americanToImplied(0) === null);
}

/* --- position math --------------------------------------------------------- */
{
    check('ev: fair price has zero edge', near(expectedValue(0.5, 1, 0.5), 0));
    check('ev: an underpriced contract is positive', expectedValue(0.6, 1, 0.5) > 0);
    check('ev: an overpriced contract is negative', expectedValue(0.4, 1, 0.5) < 0);
    check('kelly: no edge means zero stake', near(kellyFraction(0.5, 2), 0));
    check('kelly: a real edge is positive', kellyFraction(0.6, 2) > 0);
    check('kelly: a negative edge is reported negative, not clipped to zero', kellyFraction(0.4, 2) < 0);
    check('vig: a fair book has none', near(impliedVig(0.5, 0.5), 0));
    check('vig: an overround book is positive', near(impliedVig(0.55, 0.5), 0.05, 1e-9));
}

/* --- alerts fire on CROSSINGS, not levels ---------------------------------- */
{
    const item = { marketId: 'M1', source: 'kalshi', title: 'Fed holds', threshold: 0.7, direction: 'above' };

    check('alert: the first reading only sets a baseline',
        checkProbAlerts([{ ...item }], [{ marketId: 'M1', source: 'kalshi', prob: 0.75 }]).length === 0);

    check('alert: fires when the threshold is crossed upward',
        checkProbAlerts([{ ...item, lastProbability: 0.68 }], [{ marketId: 'M1', source: 'kalshi', prob: 0.72 }]).length === 1);

    check('alert: does NOT re-fire while resting above the threshold',
        checkProbAlerts([{ ...item, lastProbability: 0.72 }], [{ marketId: 'M1', source: 'kalshi', prob: 0.75 }]).length === 0);

    const below = { marketId: 'M2', source: 'polymarket', threshold: 0.3, direction: 'below', lastProbability: 0.34 };
    check('alert: downward crossing fires', checkProbAlerts([below], [{ marketId: 'M2', source: 'polymarket', prob: 0.28 }]).length === 1);
    check('alert: still above the floor does not fire',
        checkProbAlerts([{ ...below, lastProbability: 0.4 }], [{ marketId: 'M2', source: 'polymarket', prob: 0.35 }]).length === 0);

    const fired = checkProbAlerts([{ ...item, lastProbability: 0.68 }], [{ marketId: 'M1', source: 'kalshi', prob: 0.72 }])[0];
    check('alert: reports where it came from and where it went', fired.from === 0.68 && fired.prob === 0.72);
    check('alert: a missing price is skipped, not treated as zero',
        checkProbAlerts([{ ...item, lastProbability: 0.68 }], []).length === 0);
}

/* --- cross-platform matching ----------------------------------------------- */
{
    check('match: the same question scores high',
        titleSimilarity('No change in Fed interest rates after July meeting?',
            'No change in Fed interest rates after the July meeting?') > 0.8);
    check('match: unrelated questions score low',
        titleSimilarity('Will Bitcoin hit 100k?', 'Who wins the Ballon d\'Or?') < 0.2);

    const poly = [{ id: 'p1', title: 'Fed decision in July: no change', probability: 0.874 },
    { id: 'p2', title: 'Ballon d\'Or winner 2026', probability: 0.3 }];
    const kalshi = [{ id: 'k1', title: 'Fed decision July no change', probability: 0.87 },
    { id: 'k2', title: 'Hurricane landfall in Florida', probability: 0.2 }];
    const pairs = matchMarkets(poly, kalshi);
    check('match: pairs the equivalent markets only', pairs.length === 1 && pairs[0].kalshi.id === 'k1');
    check('match: an unmatched market stays unmatched rather than being forced',
        !pairs.some(p => p.polymarket.id === 'p2'));
    check('match: a Kalshi market is not reused across pairs', new Set(pairs.map(p => p.kalshi.id)).size === pairs.length);
}

/* --- spoken output --------------------------------------------------------- */
{
    const k = parseKalshiMarket(KALSHI_MARKET);
    const said = describeMarket(k);
    check('spoken: names the venue', /Kalshi/.test(said), said.slice(0, 60));
    check('spoken: states the probability', /87%/.test(said));
    check('spoken: includes traded volume', /\$482\.0K|\$482K/.test(said), said);

    const ev = parsePolymarketEvent(POLY_EVENT);
    check('spoken: a polymarket market names its venue', /Polymarket/.test(describeMarket(ev.markets[0])));

    const multi = { platform: 'polymarket', question: 'Ballon d\'Or 2026', volume: 3697700, outcomes: [
        { name: 'Mbappé', probability: 0.106 }, { name: 'Haaland', probability: 0.32 }, { name: 'Bellingham', probability: 0.21 }, { name: 'Yamal', probability: 0.18 },
    ] };
    const m = describeMarket(multi);
    check('spoken: multi-outcome leads with the favourite', /Haaland leads at 32%/.test(m), m.slice(0, 80));
    check('spoken: and counts the rest rather than reading them all', /2 other outcomes/.test(m));

    // 87.4 and 87.0 both round to 87: agreement, and saying "a 0 point spread"
    // would be noise dressed as analysis.
    const agree = describeComparison({ title: 'Fed holds in July', probability: 0.874 }, { probability: 0.87 });
    check('comparison: venues within rounding are reported as agreeing', /both venues agree at 87%/.test(agree), agree);
    const cmp = describeComparison({ title: 'Fed holds in July', probability: 0.874 }, { probability: 0.83 });
    check('comparison: states both venues', /Polymarket has it at 87%/.test(cmp) && /Kalshi at 83%/.test(cmp), cmp.slice(0, 90));
    const gap = describeComparison({ title: 'Fed holds', probability: 0.9 }, { probability: 0.8 });
    check('comparison: names the higher venue and the gap', /Polymarket is 10 points higher/.test(gap));
    check('comparison: refuses to call a gap an opportunity', /not necessarily an opportunity/.test(gap));
    check('comparison: a missing quote is admitted', /could not get a live quote/.test(describeComparison({ probability: null }, { probability: 0.5 })));

    check('trending: empty is stated plainly', /found no active/.test(describeTrending([])));
    const trend = describeTrending([{ title: 'Trump in WC photo', platform: 'polymarket', probability: 0.998, volume24hr: 5194627 }]);
    check('trending: reports probability and volume', /100%/.test(trend) && /\$5\.2M/.test(trend), trend);
}

/* --- helpers and taxonomy -------------------------------------------------- */
{
    check('volume: millions', formatVolume(5194627) === '$5.2M');
    check('volume: thousands', formatVolume(4820) === '$4.8K');
    check('volume: nothing traded', formatVolume(0) === '$0' && formatVolume(null) === '$0');
    check('prob: null stays null — no quote is not zero percent', formatProb(null) === null);
    check('time: a future close is described', timeUntil('2026-07-23T00:00:00Z', Date.parse('2026-07-21T00:00:00Z')) === '2 days');
    check('time: a passed close says ended', timeUntil('2026-07-20T00:00:00Z', Date.parse('2026-07-21T00:00:00Z')) === 'ended');
    check('time: a missing date yields null', timeUntil(null) === null);

    check('category: fed maps to economics', resolveCategory('what are the odds on a fed rate cut') === 'economics');
    check('category: bitcoin maps to crypto', resolveCategory('bitcoin 200k market') === 'crypto');
    check('category: hurricane maps to weather', resolveCategory('hurricane predictions') === 'weather');
    check('category: nothing matched yields null', resolveCategory('what time is it') === null);
    check('taxonomy: weather has no Polymarket equivalent and says so',
        PREDICTION_CATEGORIES.weather.poly === null && PREDICTION_CATEGORIES.weather.kalshi.includes('Climate and Weather'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
