// Tests for vision backend selection and page assembly. The properties that
// matter: the GPU backend is never silently demoted when it is up, a CPU-only
// machine still gets a parse, and a document whose pages all failed can never
// reach the RAG corpus looking like a successful read.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
    BACKENDS, chooseBackend, pagePrompt, buildVisionPayload,
    assemblePages, isWorthIngesting,
} = require('./visionRouter.js');

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- backend selection -------------------------------------------------------
check('choose: nothing up -> null, not a guess',
    chooseBackend({ ocrAvailable: false, visionAvailable: false }) === null);
check('choose: no arguments at all -> null',
    chooseBackend() === null);
check('choose: only the GPU server -> Unlimited-OCR',
    chooseBackend({ ocrAvailable: true }) === BACKENDS.UNLIMITED_OCR);
check('choose: only the CPU server -> VisionPsy',
    chooseBackend({ visionAvailable: true }) === BACKENDS.VISIONPSY);

// The regression this guards: someone installs the CPU fallback and their
// existing GPU parsing quietly gets worse.
check('choose: both up -> GPU backend still wins by default',
    chooseBackend({ ocrAvailable: true, visionAvailable: true }) === BACKENDS.UNLIMITED_OCR);

check('choose: explicit preference for VisionPsy is honoured when both are up',
    chooseBackend({ ocrAvailable: true, visionAvailable: true, preferred: BACKENDS.VISIONPSY })
        === BACKENDS.VISIONPSY);
check('choose: preference for a backend that is DOWN falls through, not fails',
    chooseBackend({ ocrAvailable: true, visionAvailable: false, preferred: BACKENDS.VISIONPSY })
        === BACKENDS.UNLIMITED_OCR);
check('choose: unknown preference is ignored rather than honoured',
    chooseBackend({ ocrAvailable: true, preferred: 'gemini-vision' }) === BACKENDS.UNLIMITED_OCR);
check('choose: truthy-but-not-true availability is not accepted',
    chooseBackend({ ocrAvailable: 1, visionAvailable: 'yes' }) === null);

// --- page prompt -------------------------------------------------------------
{
    const single = pagePrompt(0, 1);
    check('prompt: single page carries no page counter', !/page 1 of/.test(single));
    check('prompt: multi-page states its position', /page 2 of 5/.test(pagePrompt(1, 5)));
    // The model card warns it hallucinates on dense documents; the prompt has
    // to say so rather than relying on the model to volunteer a gap.
    check('prompt: instructs omission over guessing', /rather than guessing/.test(single));
    check('prompt: asks for Markdown, since RAG is what consumes this',
        /Markdown/.test(single));
}

// --- payload shape -----------------------------------------------------------
{
    const p = buildVisionPayload({ imageBase64: 'AAAA', prompt: 'go' });
    check('payload: temperature is zero for transcription', p.temperature === 0);
    check('payload: one user message', p.messages.length === 1 && p.messages[0].role === 'user');
    check('payload: text part precedes the image part',
        p.messages[0].content[0].type === 'text' &&
        p.messages[0].content[1].type === 'image_url');
    check('payload: image is a data URL llama-server accepts',
        p.messages[0].content[1].image_url.url === 'data:image/png;base64,AAAA');
    check('payload: token ceiling is set', p.max_tokens === 2048);
}

// --- page assembly -----------------------------------------------------------
{
    const empty = assemblePages([]);
    check('assemble: no pages -> empty, counted as zero', empty.markdown === '' && empty.ok === 0);
    check('assemble: non-array input does not throw', assemblePages(null).ok === 0);

    const one = assemblePages([{ page: 1, markdown: '# Invoice' }]);
    check('assemble: a single page carries no page marker', one.markdown === '# Invoice');
    check('assemble: single page counted', one.ok === 1 && one.failed === 0);

    const many = assemblePages([
        { page: 1, markdown: '# One' },
        { page: 2, markdown: '# Two' },
    ]);
    check('assemble: multiple pages are marked', /<!-- page 1 -->/.test(many.markdown) &&
        /<!-- page 2 -->/.test(many.markdown));
    check('assemble: both counted', many.ok === 2 && many.failed === 0);

    // A dropped page becomes a confident wrong answer once it is in the corpus
    // and nothing records that anything was missing.
    const gap = assemblePages([
        { page: 1, markdown: '# One' },
        { page: 2, error: 'timeout' },
        { page: 3, markdown: '# Three' },
    ]);
    check('assemble: a failed page is marked, never silently dropped',
        /page 2: not parsed \(timeout\)/.test(gap.markdown));
    check('assemble: partial success is counted honestly', gap.ok === 2 && gap.failed === 1);
    check('assemble: surviving pages still present', /# One/.test(gap.markdown) && /# Three/.test(gap.markdown));

    const blank = assemblePages([{ page: 1, markdown: '   ' }]);
    check('assemble: whitespace-only page counts as failed', blank.ok === 0 && blank.failed === 1);
}

// --- ingest gate -------------------------------------------------------------
{
    const allFailed = assemblePages([
        { page: 1, error: 'timeout' },
        { page: 2, error: 'timeout' },
    ]);
    check('ingest gate: well-formed markdown of pure failures is NOT ingestable',
        isWorthIngesting(allFailed) === false);
    check('ingest gate: a partial parse is worth keeping',
        isWorthIngesting(assemblePages([{ page: 1, markdown: 'x' }, { page: 2, error: 'e' }])) === true);
    check('ingest gate: null result is rejected', isWorthIngesting(null) === false);
    check('ingest gate: undefined result is rejected', isWorthIngesting(undefined) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
