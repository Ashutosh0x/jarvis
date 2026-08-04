// The scrolling code column down the left of the globe view.
//
// ---------------------------------------------------------------------------
// IT SHOWS JARVIS'S OWN SOURCE, AND THAT IS THE WHOLE POINT
//
// The reference has code scrolling behind the globe. Three ways to fill it:
// fake it with generated gibberish, stream logs, or show the running program.
//
// Gibberish is what most "hacker UI" does and it always looks like gibberish —
// the eye reads the shape of real code instantly. Logs are real but mostly
// blank, since a voice assistant sitting idle produces nothing to say.
//
// So it reads the actual modules — jarvis.js, webSearch.js, this file — and
// scrolls them. It is honest, it is never empty, and when Jarvis IS doing
// something the live line is injected into the stream, which makes the column
// a real trace rather than set dressing.
//
// COST. This sits behind a 3D globe that must hold 60fps. Rendering thousands
// of syntax-highlighted spans and animating scrollTop would repaint the layer
// every frame. Instead a fixed window of ~60 lines is rendered, the whole
// block is moved with a compositor-only transform, and the window advances by
// ONE line every couple of seconds — a DOM write every 2s, not every 16ms.
// ---------------------------------------------------------------------------

const KEYWORDS = /\b(const|let|var|function|return|if|else|for|while|await|async|class|new|import|export|from|try|catch|throw|typeof|of|in|this|null|undefined|true|false)\b/g;

/** Minimal highlighter. Order matters: comments and strings win over keywords. */
function highlight(line) {
    const escaped = line.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

    const comment = escaped.match(/^(\s*)(\/\/.*|\/\*.*|\*.*)$/);
    if (comment) return `${comment[1]}<span class="c-com">${comment[2]}</span>`;

    return escaped
        .replace(/(['"`])((?:\\.|(?!\1).)*)\1/g, '<span class="c-str">$1$2$1</span>')
        .replace(KEYWORDS, '<span class="c-kw">$&</span>')
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="c-num">$1</span>');
}

export function createCodeOverlay({ mount, loadSource, files = [], lines = 60, lineMs = 1800 }) {
    const root = document.createElement('div');
    root.className = 'code-overlay';
    root.innerHTML = '<div class="code-scroll"><pre class="code-pre"></pre></div>';
    mount.appendChild(root);

    const pre = root.querySelector('.code-pre');
    const scroller = root.querySelector('.code-scroll');

    let source = [];
    let sourceName = '';
    let cursor = 0;
    let fileIndex = 0;
    let paused = false;
    let timer = null;
    /* Live entries are interleaved with the source rather than replacing it,
       so the column keeps moving when nothing is happening. */
    const live = [];

    root.addEventListener('mouseenter', () => { paused = true; });
    root.addEventListener('mouseleave', () => { paused = false; });

    async function loadNext() {
        if (!files.length) return;
        const file = files[fileIndex % files.length];
        fileIndex++;
        try {
            const text = await loadSource(file);
            source = String(text).split('\n');
            sourceName = file;
            /* Start somewhere in the middle: the top of a file is imports and
               licence headers, which is the least interesting sixty lines in
               it. */
            cursor = Math.floor(Math.random() * Math.max(1, source.length - lines - 1));
        } catch {
            /* A file that cannot be read is not worth surfacing to the user —
               the column simply keeps showing whatever it already had. */
        }
    }

    function render() {
        if (!source.length) return;
        const out = [];
        for (let i = 0; i < lines; i++) {
            const n = cursor + i;
            if (n >= source.length) break;
            const injected = live.find((l) => l.at === n);
            const text = injected ? injected.text : source[n];
            const cls = injected ? 'code-line live' : 'code-line';
            out.push(`<span class="${cls}"><span class="ln">${String(n + 1).padStart(4)}</span>${highlight(text)}</span>`);
        }
        pre.innerHTML = out.join('\n');
    }

    function tick() {
        if (!paused) {
            cursor++;
            if (cursor + lines >= source.length) loadNext().then(render);
            else render();
        }
        timer = setTimeout(tick, lineMs);
    }

    /** Put a real line of Jarvis activity into the stream. */
    function log(text) {
        live.unshift({ at: cursor + Math.floor(lines * 0.35), text: `// ${text}` });
        if (live.length > 12) live.pop();
        render();
    }

    async function start() {
        await loadNext();
        render();
        if (!timer) tick();
    }

    function setVisible(on) {
        root.style.display = on ? 'block' : 'none';
        if (on && !timer) tick();
        if (!on && timer) { clearTimeout(timer); timer = null; }
    }

    function dispose() {
        if (timer) clearTimeout(timer);
        root.remove();
    }

    return { root, start, setVisible, log, dispose, currentFile: () => sourceName };
}

export default { createCodeOverlay };
