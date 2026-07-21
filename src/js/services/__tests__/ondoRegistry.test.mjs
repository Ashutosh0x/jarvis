// Tests for the Ondo registry. Load-bearing: voice resolution must hit the
// right token from messy STT text, and must NOT false-positive on unrelated
// speech (a wrong contract queried is a wrong number spoken as fact).
import { resolveOndoToken, parseOndoQuery, BY_ADDRESS, HOT_LIST, ONDO_COUNT } from '../ondoRegistry.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- registry shape -----------------------------------------------------------
check('registry: all 440 catalog tokens loaded', ONDO_COUNT === 440);
check('registry: address map covers eth+bsc', BY_ADDRESS.size >= 800);
check('registry: known AAPLon eth address maps back',
    BY_ADDRESS.get('0x14c3abf95cb9c93a8b82c1cdcb76d72cb87b2d4c')?.k === 'AAPL');
check('registry: hot list resolved fully', HOT_LIST.length >= 12 && HOT_LIST.every(t => t.e));

// --- resolution: tickers, symbols, names ---------------------------------------
check('resolve: bare ticker', resolveOndoToken('supply of NVDA')?.k === 'NVDA');
check('resolve: on-chain symbol', resolveOndoToken('how many aaplon exist')?.k === 'AAPL');
check('resolve: company name', resolveOndoToken('tokenized apple supply')?.k === 'AAPL');
check('resolve: tesla by name', resolveOndoToken('how many tesla tokens')?.k === 'TSLA');
check('resolve: nvidia by name', resolveOndoToken('tokenized nvidia')?.k === 'NVDA');
check('resolve: etf by ticker', resolveOndoToken('SPY supply')?.k === 'SPY');

// --- aliases (STT reality) ------------------------------------------------------
check('alias: google -> GOOGL', resolveOndoToken('tokenized google')?.k === 'GOOGL');
check('alias: facebook -> META', resolveOndoToken('facebook tokens')?.k === 'META');
check('alias: nasdaq -> QQQ', resolveOndoToken('the nasdaq token')?.k === 'QQQ');
check('alias: gold -> GLD', resolveOndoToken('tokenized gold supply')?.k === 'GLD');

// --- non-matches must stay null --------------------------------------------------
check('no match: unrelated speech', resolveOndoToken('what time is it') === null);
check('no match: empty', resolveOndoToken('') === null);
check('no match: null', resolveOndoToken(null) === null);
check('no match: substring cannot fire (visa inside improvisation)',
    resolveOndoToken('an improvisation exercise') === null);

// --- entries carry what the handlers need ----------------------------------------
{
    const t = resolveOndoToken('NVDA');
    check('entry: has eth address', /^0x[0-9a-f]{40}$/.test(t.e));
    check('entry: has bsc address', /^0x[0-9a-f]{40}$/.test(t.b));
    check('entry: has spoken name', typeof t.n === 'string' && t.n.length > 0);
    check('entry: has type', t.t === 'Stock');
}

// --- English-word tickers must never match as bare words (real log: "minting
// --- activity ON tokenized nvidia" resolved to ON Semiconductor) ----------------
check('word ticker: "on" does not resolve to ON Semi',
    parseOndoQuery('minting activity on tokenized nvidia')?.ondo?.k === 'NVDA');
check('word ticker: "so" does not resolve', resolveOndoToken('supply is so large for tokenized apple')?.k === 'AAPL');
check('word ticker: name path still reaches CAT', resolveOndoToken('tokenized caterpillar')?.k === 'CAT');
check('word ticker: symbol form still reaches CAT', resolveOndoToken('supply of caton')?.k === 'CAT');
check('word ticker: name path still reaches ServiceNow', resolveOndoToken('tokenized servicenow')?.k === 'NOW');

// --- intent parsing: must NOT steal quant/price/news queries --------------------
// parseOnchainQuery runs before those parsers, so any hit here would hijack them.
check('parse: "price of apple" stays null (quote query)', parseOndoQuery('price of apple') === null);
check('parse: "how much is bitcoin" stays null (quote query)', parseOndoQuery('how much is bitcoin') === null);
check('parse: "analyze tesla" stays null (quant)', parseOndoQuery('analyze tesla') === null);
check('parse: "sharpe ratio of apple" stays null (quant)', parseOndoQuery('sharpe ratio of apple') === null);
check('parse: "market cap of apple" stays null (company, not token)', parseOndoQuery('market cap of apple') === null);
check('parse: "news about nvidia" stays null (news)', parseOndoQuery('news about nvidia') === null);
check('parse: unrelated speech stays null', parseOndoQuery('what time is it') === null);
check('parse: "whale activity today" stays null (stream summary)', parseOndoQuery('whale activity today') === null);

// --- intent parsing: real Ondo asks ----------------------------------------------
check('parse: supply via tokenized name', parseOndoQuery('supply of tokenized apple')?.kind === 'ondo-supply');
check('parse: supply resolves right token', parseOndoQuery('supply of tokenized apple')?.ondo?.k === 'AAPL');
check('parse: supply via on-chain symbol', parseOndoQuery('how many aaplon exist')?.kind === 'ondo-supply');
check('parse: "how many tesla tokens are there"', parseOndoQuery('how many tesla tokens are there')?.kind === 'ondo-supply'
    && parseOndoQuery('how many tesla tokens are there')?.ondo?.k === 'TSLA');
check('parse: market cap WITH tokenized context', parseOndoQuery('market cap of tokenized apple')?.kind === 'ondo-supply');
check('parse: flows via mint/redeem', parseOndoQuery('mints and redemptions for tokenized nvidia')?.kind === 'ondo-flows');
check('parse: flows default to keyless 24h (days null)', parseOndoQuery('minting activity on tokenized apple')?.days === null);
check('parse: flows with period -> days for Dune path', parseOndoQuery('supply history of tokenized apple over 30 days')?.days === 30);
check('parse: flows "this week" -> 7 days', parseOndoQuery('redemption history of tokenized tesla this week')?.days === 7);
check('parse: holders', parseOndoQuery('top holders of tokenized apple')?.kind === 'ondo-holders');
check('parse: holders via who holds', parseOndoQuery('who holds the most nvdaon')?.kind === 'ondo-holders');
check('parse: info fallback', parseOndoQuery('what is tokenized google')?.kind === 'ondo-info'
    && parseOndoQuery('what is tokenized google')?.ondo?.k === 'GOOGL');
check('parse: catalog', parseOndoQuery('which tokenized stocks exist')?.kind === 'ondo-catalog');
check('parse: catalog via ondo tokens', parseOndoQuery('how many ondo tokens are there')?.kind === 'ondo-catalog');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
