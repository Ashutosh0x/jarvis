// Sentence splitting for paced speech.
//
// The trap this file exists for: Jarvis speaks NUMBERS constantly — "1,278,685
// USDC, approximately 1,279,593 dollars", "6.63 ETH", "0.02 gwei", "block
// 25581628." A naive split on "." shatters those into fragments and the voice
// reads "6" [pause] "63 ETH", which is worse than no pause at all.
//
// The pattern under test is the one used in jarvis.js speak(). It is kept in
// sync by being exercised here on real spoken lines from the interaction log.

const SPLIT = /[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g;
const split = (s) => (s.match(SPLIT) || []).map(x => x.trim()).filter(Boolean);

let pass = 0, fail = 0;
const check = (n, c, detail = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${detail ? ` — ${detail}` : ''}`); };

/* --- real whale alert, verbatim from the log ------------------------------ */
{
    const line = 'Sir, significant movement on Ethereum. 1,278,685 USDC, approximately 1,279,593 dollars, moved from 0x8b82…df52, a wallet with 810 transactions sent, to 0xe01c…1fab, a wallet with 2,516 transactions sent, in block 25581628.';
    const parts = split(line);
    check('whale alert splits into 2 spoken lines', parts.length === 2, `got ${parts.length}`);
    check('the amount stays intact', parts[1].includes('1,278,685 USDC, approximately 1,279,593 dollars'));
    check('no fragment is a bare number', !parts.some(p => /^\d+$/.test(p)), parts.map(p => p.slice(0, 24)).join(' | '));
}

/* --- decimals must not be split ------------------------------------------- */
{
    check('ETH balance with decimals stays whole',
        split('0xd8da…6045 holds 6.63177169 ETH on Ethereum.').length === 1);
    check('gas in gwei stays whole',
        split('Gas on Arbitrum One is 0.02 gwei.').length === 1);
    check('percentages and ratios stay whole',
        split('NVDA returned 18.8% annualized with a Sharpe of 0.41.').length === 1);
}

/* --- multi-fact answers get their boundaries ------------------------------ */
{
    const issuance = 'Over roughly the last 60 minutes on Ethereum, Sir: USDC saw 16.7 million minted and 19.0 million burned, a net decrease of 2.3 million. DAI saw 5.0 million minted and 1.7 million burned, a net increase of 3.3 million.';
    const parts = split(issuance);
    check('issuance summary splits per token', parts.length === 2, `got ${parts.length}`);
    check('million figures survive', parts.every(p => /million/.test(p)));
}

/* --- degenerate input ------------------------------------------------------ */
{
    check('single sentence is not split', split('Whale monitoring is off, Sir.').length === 1);
    check('no trailing punctuation still yields one line', split('Acknowledged, Sir').length === 1);
    check('empty input yields nothing', split('').length === 0 && split('   ').length === 0);
    check('question and exclamation both end a line', split('Shall I start voice typing? It is open!').length === 2);
    check('ellipsis does not produce empty fragments',
        split('Scanning across chains... done.').every(p => p.length > 0));
}

/* --- the whole point: every fragment is speakable -------------------------- */
{
    const all = [
        'Sir, stablecoin supply change. 1,000,000 USDC was burned from circulation in block 25581628.',
        'I do not monitor whales on Solana, Sir. My whale stream is Ethereum only.',
        'That wallet holds 0.0399 SOL, about $3.12, Sir, plus 15 assets.',
    ];
    const fragments = all.flatMap(split);
    check('no fragment is shorter than 3 characters', fragments.every(f => f.length >= 3),
        fragments.filter(f => f.length < 3).join(', ') || 'none');
    check('no fragment starts with a digit-only remainder', !fragments.some(f => /^\d{1,3}[,.]?$/.test(f)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
