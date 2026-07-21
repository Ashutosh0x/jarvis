// Tests for network discovery parsing. Fixtures are REAL output captured from
// this machine — the parsers exist so questions like "what's the IP of X" are
// answered from measurement instead of the model inventing an address.
import {
    parseWifiNetworks, bestSignal, matchNetwork, parseArpTable,
    macFacts, parseBluetoothDevices,
} from '../netDiscovery.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// Real `netsh wlan show networks mode=bssid` output, extended with a second
// network and a second BSSID to cover the multi-AP and hidden-SSID shapes.
const NETSH = `
Interface name : Wi-Fi
There are 2 networks currently visible.

SSID 1 : Temple tree 2nd 2_5G
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 3c:52:a1:35:75:b2
         Signal             : 100%
         Radio type         : 802.11ac
         Band               : 5 GHz
         Channel            : 157
         Bss Load:
             Connected Stations:         3
             Channel Utilization:        0 (0 %)
         Basic rates (Mbps) : 6 12 24
    BSSID 2                 : 3c:52:a1:35:75:b3
         Signal             : 62%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 6

SSID 2 :
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : aa:bb:cc:dd:ee:ff
         Signal             : 40%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 11
`;
const nets = parseWifiNetworks(NETSH);

// --- Wi-Fi scan parsing -----------------------------------------------------
check('wifi: two networks parsed', nets.length === 2);
check('wifi: strongest network first', nets[0].ssid === 'Temple tree 2nd 2_5G');
check('wifi: hidden SSID labelled', nets.some(n => n.ssid === '(hidden)'));
check('wifi: auth captured', nets[0].auth === 'WPA2-Personal');
check('wifi: encryption captured', nets[0].encryption === 'CCMP');
check('wifi: both BSSIDs kept', nets[0].bssids.length === 2);
check('wifi: BSSID colons NOT corrupted by the split',
    nets[0].bssids[0].bssid === '3c:52:a1:35:75:b2');
check('wifi: signal parsed from percent string', nets[0].bssids[0].signal === 100);
check('wifi: channel parsed', nets[0].bssids[0].channel === 157);
check('wifi: band captured', nets[0].bssids[0].band === '5 GHz');
check('wifi: radio captured', nets[0].bssids[0].radio === '802.11ac');
check('wifi: connected stations parsed', nets[0].bssids[0].stations === 3);
check('wifi: BSSIDs sorted strongest first', nets[0].bssids[1].signal === 62);
check('wifi: "Basic rates" line does not become a field',
    nets[0].bssids[0].radio === '802.11ac' && nets[0].bssids[0].channel === 157);
check('wifi: bestSignal', bestSignal(nets[0]) === 100);
check('wifi: bestSignal on empty is null', bestSignal({ bssids: [] }) === null);
check('wifi: empty input is empty list', parseWifiNetworks('').length === 0);

// --- fuzzy SSID matching (STT reality: "pro heaven" for "Pro Haven") --------
check('match: exact', matchNetwork(nets, 'Temple tree 2nd 2_5G')?.ssid === 'Temple tree 2nd 2_5G');
check('match: punctuation and case ignored',
    matchNetwork(nets, 'temple tree 2nd 25g')?.ssid === 'Temple tree 2nd 2_5G');
check('match: spoken fragment matches longer SSID',
    matchNetwork(nets, 'temple tree')?.ssid === 'Temple tree 2nd 2_5G');
check('match: unknown name returns null', matchNetwork(nets, 'pro haven') === null);
check('match: empty returns null', matchNetwork(nets, '') === null);
check('match: no networks returns null', matchNetwork([], 'anything') === null);

// --- ARP parsing -------------------------------------------------------------
const ARP = `
Interface: 192.168.56.1 --- 0x4
  Internet Address      Physical Address      Type
  192.168.56.255        ff-ff-ff-ff-ff-ff     static
  224.0.0.251           01-00-5e-00-00-fb     static

Interface: 192.168.0.101 --- 0x10
  Internet Address      Physical Address      Type
  192.168.0.1           3c-52-a1-35-75-b0     dynamic
  192.168.0.105         a4-50-46-11-22-33     dynamic
  192.168.0.255         ff-ff-ff-ff-ff-ff     static
  239.255.255.250       01-00-5e-7f-ff-fa     static
`;
const arp = parseArpTable(ARP);
check('arp: only real hosts kept', arp.length === 2);
check('arp: broadcast dropped', !arp.some(a => a.mac.startsWith('ff-ff')));
check('arp: multicast dropped', !arp.some(a => a.ip.startsWith('224.') || a.ip.startsWith('239.')));
check('arp: gateway present', arp.some(a => a.ip === '192.168.0.1'));
check('arp: mac lowercased', arp[0].mac === '3c-52-a1-35-75-b0');
check('arp: interface attributed', arp[0].iface === '192.168.0.101');
check('arp: type captured', arp[0].type === 'dynamic');
check('arp: empty input safe', parseArpTable('').length === 0);

// --- MAC facts: only what the address itself proves, no lookup table ----------
// The previous version shipped nine hand-picked OUI prefixes; that is a guess
// list, so it was removed rather than extended.
check('mac: universally administered address', macFacts('3c-52-a1-35-75-b0').locallyAdministered === false);
check('mac: locally administered bit detected', macFacts('02-00-00-11-22-33').locallyAdministered === true);
check('mac: randomised phone MAC detected', macFacts('a6-50-46-11-22-33').locallyAdministered === true);
check('mac: multicast bit detected', macFacts('01-00-5e-00-00-fb').multicast === true);
check('mac: unicast is not multicast', macFacts('3c-52-a1-35-75-b0').multicast === false);
check('mac: colon separators accepted', macFacts('3c:52:a1:35:75:b0') !== null);
check('mac: garbage is null', macFacts('') === null);
check('mac: wrong length is null', macFacts('3c-52-a1') === null);

// --- Bluetooth device dedup ----------------------------------------------------
const BT = [
    { status: 'Unknown', name: 'Bluetooth Device (RFCOMM Protocol TDI)' },
    { status: 'Unknown', name: 'OnePlus Buds 3 Avrcp Transport' },
    { status: 'Unknown', name: 'OnePlus Buds 3 Avrcp Transport' },
    { status: 'OK', name: 'OnePlus Buds 3' },
    { status: 'OK', name: 'Realtek Bluetooth 5 Adapter' },
    { status: 'Unknown', name: 'Microsoft Bluetooth Enumerator' },
    { status: 'Unknown', name: 'Device Identification Service' },
    { status: 'Unknown', name: 'Microsoft Bluetooth LE Enumerator' },
];
const bt = parseBluetoothDevices(BT);
check('bt: service nodes filtered out', !bt.some(d => /enumerator|rfcomm|identification/i.test(d.name)));
check('bt: the headset appears exactly once',
    bt.filter(d => /onePlus buds 3/i.test(d.name)).length === 1);
check('bt: avrcp suffix folded into the real device name',
    bt.some(d => d.name === 'OnePlus Buds 3'));
check('bt: connected status derived from OK',
    bt.find(d => d.name === 'OnePlus Buds 3')?.connected === true);
check('bt: adapter classified separately',
    bt.find(d => /Realtek/.test(d.name))?.kind === 'adapter');
check('bt: connected devices sort first', bt[0].connected === true);
check('bt: empty input safe', parseBluetoothDevices([]).length === 0);
check('bt: null input safe', parseBluetoothDevices(null).length === 0);

// --- determinism ---------------------------------------------------------------
check('determinism: wifi parse stable',
    JSON.stringify(parseWifiNetworks(NETSH)) === JSON.stringify(nets));
check('determinism: bluetooth parse stable',
    JSON.stringify(parseBluetoothDevices(BT)) === JSON.stringify(bt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
