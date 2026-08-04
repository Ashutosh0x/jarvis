// The bottom bar: what Jarvis is looking at, and what is coming in.
//
// Two parts, matching the reference: a centred rounded plate saying what the
// globe is showing, and a right-hand column of alert lines.
//
// The ticker does NOT scroll horizontally. The reference shows three static
// stacked lines, and that is also the better choice: a marquee forces the
// reader to wait for text to arrive, and anything urgent enough to be an alert
// should be readable the moment it appears. New alerts push in at the top.

const MAX_ALERTS = 3;

export function createStatusBar({ mount }) {
    const root = document.createElement('div');
    root.className = 'globe-status-bar';
    root.innerHTML = `
        <div class="gsb-left"></div>
        <div class="gsb-center">
            <div class="gsb-plate">
                <span class="gsb-primary">JARVIS: Global monitoring standby.</span>
                <span class="gsb-secondary">Awaiting target parameters.</span>
            </div>
        </div>
        <div class="gsb-right"><div class="gsb-alerts"></div></div>`;
    mount.appendChild(root);

    const primary = root.querySelector('.gsb-primary');
    const secondary = root.querySelector('.gsb-secondary');
    const alerts = root.querySelector('.gsb-alerts');

    /** "JARVIS: San Francisco real-time data active." */
    function setTarget(place, action = 'Tracking target parameters.') {
        primary.textContent = place
            ? `JARVIS: ${place} real-time data active.`
            : 'JARVIS: Global monitoring standby.';
        secondary.textContent = action;
    }

    /**
     * Push an alert line.
     * @param {'breaking'|'alert'|'info'} kind
     */
    function pushAlert(text, kind = 'info') {
        const line = document.createElement('div');
        line.className = `gsb-alert kind-${kind}`;
        const label = kind === 'breaking' ? 'Breaking' : kind === 'alert' ? 'Alert' : 'Info';
        line.innerHTML = `<span class="gsb-alert-label">${label}:</span> <span class="gsb-alert-text"></span>`;
        line.querySelector('.gsb-alert-text').textContent = text;
        alerts.prepend(line);
        while (alerts.children.length > MAX_ALERTS) alerts.lastElementChild.remove();
        /* Animate in on the next frame so the transition has a start state to
           move from — setting both in the same frame skips the animation. */
        requestAnimationFrame(() => line.classList.add('in'));
    }

    function clearAlerts() { alerts.innerHTML = ''; }
    function setVisible(on) { root.style.display = on ? 'grid' : 'none'; }
    function dispose() { root.remove(); }

    setVisible(false);
    return { root, setTarget, pushAlert, clearAlerts, setVisible, dispose };
}

export default { createStatusBar };
