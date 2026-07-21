// Known-value tests for the on-chain math/format engine. The rule under test:
// converting raw chain integers to human numbers must be EXACT (BigInt), never
// float-approximated — a wrong balance is worse than no balance.
import {
    isAddress, hexToBigInt, formatUnits, formatEther, formatGwei,
    groupThousands, shortAddress, encodeBalanceOf, resolveChain, resolveToken,
    extractAddress, CHAINS, TOKENS,
    INTERFACE_IDS, encodeSupportsInterface, decodeBool, decodeAbiString, classifyContract,
    TRANSFER_TOPIC, topicToAddress, decodeTransferLog, resolveTokenByAddress,
} from '../onchain.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

// --- address handling ---
check('isAddress: valid', isAddress(VITALIK));
check('isAddress: too short', !isAddress('0x1234'));
check('isAddress: non-hex', !isAddress('0xZZZa6BF26964aF9D7eEd9e03E53415D37aA96045'));
check('extractAddress from prose', extractAddress(`balance of ${VITALIK} on arbitrum`) === VITALIK);
check('shortAddress', shortAddress(VITALIK) === '0xd8dA…6045');

// --- hex parsing (exactness on large values) ---
check('hexToBigInt basic', hexToBigInt('0x1a') === 26n);
check('hexToBigInt no prefix', hexToBigInt('ff') === 255n);
check('hexToBigInt empty -> 0', hexToBigInt('0x') === 0n);
// 1.5 ETH in wei = 0x14d1120d7b160000
check('hexToBigInt 1.5 ETH', hexToBigInt('0x14d1120d7b160000') === 1500000000000000000n);

// --- formatUnits: the core correctness surface ---
check('formatUnits 1.5 ETH', formatEther(1500000000000000000n) === '1.5');
check('formatUnits exactly 1 ETH', formatEther(1000000000000000000n) === '1');
check('formatUnits USDC 1240.5 (6 dp)', formatUnits(1240500000n, 6) === '1240.5');
check('formatUnits USDC 0.000001', formatUnits(1n, 6) === '0.000001');
check('formatUnits zero', formatUnits(0n, 18) === '0');
check('formatUnits caps fraction at maxFrac', formatEther(1234567890123456789n, 4) === '1.2345');
check('formatUnits trims trailing zeros', formatUnits(1200000n, 6) === '1.2');
// A whale-sized value must stay exact (float would lose precision here).
check('formatUnits huge stays exact', formatEther(123456789012345678901234567890n) === '123456789012.345678');

// --- gwei ---
check('formatGwei 20 gwei', formatGwei(20000000000n) === '20');
check('formatGwei 0.02 gwei', formatGwei(20000000n) === '0.02');

// --- thousands grouping ---
check('groupThousands int', groupThousands('1234567') === '1,234,567');
check('groupThousands with frac', groupThousands('1240.5') === '1,240.5');
check('groupThousands small', groupThousands('42') === '42');

// --- ERC-20 calldata ---
check('encodeBalanceOf selector + padded addr',
    encodeBalanceOf(VITALIK) === '0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045');
check('encodeBalanceOf length is 4+32 bytes', encodeBalanceOf(VITALIK).length === 2 + 8 + 64);

// --- chain resolution ---
check('resolveChain arbitrum', resolveChain('balance on arbitrum') === 'arbitrum');
check('resolveChain arb short', resolveChain('gas on arb') === 'arbitrum');
check('resolveChain base', resolveChain('usdc on base') === 'base');
check('resolveChain matic->polygon', resolveChain('gas on matic') === 'polygon');
check('resolveChain default ethereum', resolveChain('what does this address hold') === 'ethereum');

// --- token resolution ---
check('resolveToken USDC arbitrum', resolveToken('usdc balance', 'arbitrum')?.decimals === 6);
check('resolveToken WETH 18 dp', resolveToken('weth holdings', 'ethereum')?.decimals === 18);
check('resolveToken unknown -> null', resolveToken('doge balance', 'ethereum') === null);
check('resolveToken ARB only on arbitrum', resolveToken('arb balance', 'ethereum') === null && resolveToken('arb balance', 'arbitrum')?.symbol === 'ARB');

// --- metadata sanity ---
check('all chains have native + explorer', Object.values(CHAINS).every((c) => c.native && c.explorer));
check('USDC is 6 decimals everywhere it appears',
    Object.values(TOKENS).every((m) => !m.USDC || m.USDC.decimals === 6));

// --- ERC classification: encoders/decoders ---
check('supportsInterface calldata for ERC721',
    encodeSupportsInterface(INTERFACE_IDS.erc721) === '0x01ffc9a780ac58cd' + '0'.repeat(56));
check('supportsInterface calldata is 4+32 bytes', encodeSupportsInterface(INTERFACE_IDS.erc1155).length === 2 + 8 + 64);
check('decodeBool true', decodeBool('0x0000000000000000000000000000000000000000000000000000000000000001') === true);
check('decodeBool false', decodeBool('0x0000000000000000000000000000000000000000000000000000000000000000') === false);
// Dynamic ABI string "USDC": offset 0x20, len 4, "USDC" padded.
{
    const usdc = '0x' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000004' +
        '5553444300000000000000000000000000000000000000000000000000000000';
    check('decodeAbiString dynamic "USDC"', decodeAbiString(usdc) === 'USDC');
}
// Legacy bytes32 string "MKR".
check('decodeAbiString bytes32 "MKR"',
    decodeAbiString('0x4d4b520000000000000000000000000000000000000000000000000000000000') === 'MKR');

// --- classifyContract verdicts ---
check('classify ERC721', classifyContract({ is721: true, is721Meta: true }).standard === 'ERC-721');
check('classify ERC1155', classifyContract({ is1155: true }).standard === 'ERC-1155');
check('classify ERC20 by decimals', classifyContract({ decimalsRaw: '0x0000000000000000000000000000000000000000000000000000000000000006', symbol: 'USDC' }).decimals === 6);
check('classify unknown', classifyContract({}).standard === null);
check('classify prefers 721 over 20-probe', classifyContract({ is721: true, decimalsRaw: '0x06' }).standard === 'ERC-721');

// --- transaction log decoding ---
{
    const addrTopic = '0x000000000000000000000000d8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    check('topicToAddress low-20-bytes', topicToAddress(addrTopic).toLowerCase() === '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
    check('topicToAddress too short -> null', topicToAddress('0x1234') === null);

    // 8,300,000 USDC (6 dp) = 8_300_000_000_000 base units.
    const usdcLog = {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        topics: [TRANSFER_TOPIC,
            '0x000000000000000000000000abababababababababababababababababababab',
            '0x000000000000000000000000cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'],
        data: '0x' + (8300000000000n).toString(16).padStart(64, '0'),
    };
    const d = decodeTransferLog(usdcLog);
    check('decodeTransferLog from', d.from === '0xabababababababababababababababababababab');
    check('decodeTransferLog to', d.to === '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd');
    check('decodeTransferLog amount exact', d.amount === 8300000000000n);
    check('decodeTransferLog amount formats to 8,300,000', groupThousands(formatUnits(d.amount, 6)) === '8,300,000');
    check('decodeTransferLog not NFT', d.isNft === false);
    check('resolveTokenByAddress finds USDC', resolveTokenByAddress('ethereum', usdcLog.address).symbol === 'USDC');

    // ERC-721 Transfer: tokenId in 4th topic, empty data.
    const nftLog = {
        address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
        topics: [TRANSFER_TOPIC,
            '0x000000000000000000000000abababababababababababababababababababab',
            '0x000000000000000000000000cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
            '0x0000000000000000000000000000000000000000000000000000000000000457'],
        data: '0x',
    };
    const n = decodeTransferLog(nftLog);
    check('decodeTransferLog NFT tokenId from topic', n.isNft === true && n.amount === 0x457n);

    // A non-Transfer log is ignored.
    check('decodeTransferLog ignores other events',
        decodeTransferLog({ address: '0x00', topics: ['0xdeadbeef'], data: '0x' }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
