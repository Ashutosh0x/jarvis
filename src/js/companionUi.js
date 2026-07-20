// Android Companion pairing overlay.
//
// Opens a time-boxed pairing window on the main process, renders the QR the
// phone scans, and reports when a device actually links up.

const overlay = document.getElementById('companion-overlay');
const qrImg = document.getElementById('companion-qr');
const urlEl = document.getElementById('companion-url');
const statusEl = document.getElementById('companion-status');
const closeBtn = document.getElementById('companion-close');

let countdownTimer = null;

function setStatus(text, kind = '') {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = kind;
}

export async function openCompanionPairing() {
    if (!window.electronAPI?.companionOpenPairing) {
        console.warn('Companion API unavailable (running outside Electron?)');
        return;
    }

    const info = await window.electronAPI.companionOpenPairing();

    if (info.error) {
        overlay.classList.add('visible');
        setStatus(info.error, 'err');
        return;
    }

    qrImg.src = info.qrDataUrl;
    urlEl.textContent = info.installUrl;
    overlay.classList.add('visible');

    if (!info.apkBuilt) {
        // The QR still works for an already-installed phone; only the download
        // link is dead, so say exactly that rather than failing the whole flow.
        setStatus('APK not built — run companion/gradlew assembleDebug', 'err');
    } else {
        startCountdown(info.expiresAt);
    }
}

function startCountdown(expiresAt) {
    clearInterval(countdownTimer);
    const tick = () => {
        const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        if (left === 0) {
            clearInterval(countdownTimer);
            setStatus('Pairing window closed', 'err');
            return;
        }
        const m = Math.floor(left / 60);
        const s = String(left % 60).padStart(2, '0');
        setStatus(`Pairing window open — ${m}:${s}`);
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
}

export function closeCompanionPairing() {
    clearInterval(countdownTimer);
    overlay?.classList.remove('visible');
    window.electronAPI?.companionClosePairing?.();
}

closeBtn?.addEventListener('click', closeCompanionPairing);

// Escape closes, matching the rest of the HUD's overlays.
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay?.classList.contains('visible')) {
        closeCompanionPairing();
    }
});

// A phone that completes /pair reports back here.
window.electronAPI?.onCompanionPaired?.((_e, device) => {
    setStatus(`Paired: ${device.model || 'device'} — waiting for link`, 'ok');
});

window.electronAPI?.onCompanionDevices?.((_e, devices) => {
    if (!devices.length) return;
    const d = devices[0];
    setStatus(`Linked: ${d.model || d.remote || 'device'}`, 'ok');
    // Leave the card up briefly so the success state is actually seen.
    setTimeout(closeCompanionPairing, 2500);
});

// Exposed so the AI command handler and any HUD button can trigger it.
window.jarvisCompanion = {
    open: openCompanionPairing,
    close: closeCompanionPairing
};
