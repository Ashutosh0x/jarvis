// keccak-256 + ENS namehash correctness. keccak is cross-checked against public
// vectors AND against selectors/topics this codebase already hardcoded — so a
// permutation bug cannot pass silently.
import { keccak256Utf8, selector } from '../keccak.js';
import { namehash, reverseNode, ENS_SELECTORS, decodeAddress, looksLikeEnsName } from '../ens.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- keccak-256 public vectors ---
check('keccak256("")', keccak256Utf8('') === '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
check('keccak256("abc")', keccak256Utf8('abc') === '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
check('keccak256("hello")', keccak256Utf8('hello') === '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8');

// --- cross-check against selectors/topics already hardcoded elsewhere ---
check('selector balanceOf(address) == 0x70a08231 (matches onchain.js)', selector('balanceOf(address)') === '0x70a08231');
check('selector decimals() == 0x313ce567', selector('decimals()') === '0x313ce567');
check('selector transfer(address,uint256) == 0xa9059cbb', selector('transfer(address,uint256)') === '0xa9059cbb');
check('Transfer topic matches onchain.js TRANSFER_TOPIC',
    keccak256Utf8('Transfer(address,address,uint256)') === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');

// --- ENS selectors ---
check('ENS resolver(bytes32) selector', ENS_SELECTORS.resolver === '0x0178b8bf');
check('ENS addr(bytes32) selector', ENS_SELECTORS.addr === '0x3b3b57de');
check('ENS name(bytes32) selector', ENS_SELECTORS.name === '0x691f3431');

// --- namehash (EIP-137 known values) ---
check('namehash("") is 32 zero bytes', namehash('') === '0x' + '0'.repeat(64));
check('namehash("eth")', namehash('eth') === '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
check('namehash("foo.eth")', namehash('foo.eth') === '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f');
check('namehash is case-insensitive', namehash('Foo.ETH') === namehash('foo.eth'));

// --- reverse node shape ---
check('reverseNode returns a 32-byte node',
    /^0x[0-9a-f]{64}$/.test(reverseNode('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')));

// --- helpers ---
check('decodeAddress low-20-bytes', decodeAddress('0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045') === '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
check('decodeAddress zero -> null', decodeAddress('0x' + '0'.repeat(64)) === null);
check('looksLikeEnsName vitalik.eth', looksLikeEnsName('vitalik.eth'));
check('looksLikeEnsName rejects plain word', !looksLikeEnsName('vitalik'));
check('looksLikeEnsName rejects 0x addr', !looksLikeEnsName('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
