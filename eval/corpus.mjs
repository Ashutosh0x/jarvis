/**
 * BENCHMARK CORPUS — labelled retrieval and memory evaluation data.
 *
 * HONEST FRAMING, because this determines what the numbers mean:
 *
 * This corpus is SYNTHETIC. It is written to look like what actually lands in
 * this assistant's memory — voice notes with speech-recognition damage, phone
 * messages, OCR'd document fragments, distilled preferences — but no real user
 * produced it. Nobody's private data is in a benchmark file.
 *
 * What that means for the results:
 *   * A retrieval score here measures the RANKER on realistic text. It is a
 *     valid comparison BETWEEN configurations, because every configuration sees
 *     exactly the same corpus and questions.
 *   * It is NOT a claim about accuracy on the user's own memory, which is a
 *     different distribution and which no benchmark I can write would predict.
 *
 * Questions are labelled with the document that actually answers them. Several
 * are deliberately adversarial in ways this system is known to face:
 *   * paraphrase with zero lexical overlap (dense retrieval must carry it)
 *   * rare proper nouns (lexical must carry it — embeddings blur names)
 *   * speech-recognition damage in the STORED text, not just the query
 *   * near-duplicate distractors that differ in one decisive detail
 */

export const DOCS = [
    // --- preferences and identity -------------------------------------------
    { id: 'pref-browser', source: 'reflection', text: 'Ashutosh uses Chrome as his primary browser on the desktop, with Firefox kept only for testing rendering differences.' },
    { id: 'pref-editor', source: 'reflection', text: 'His editor is VS Code with Vim keybindings enabled. He dislikes autoformat-on-save because it fights his diff hygiene.' },
    { id: 'pref-theme', source: 'reflection', text: 'He keeps every interface in dark mode and finds light themes physically uncomfortable after about twenty minutes.' },
    { id: 'pref-coffee', source: 'voice-note', text: 'He drinks black coffee before noon and switches to green tea afterwards, because caffeine after two in the afternoon wrecks his sleep.' },
    { id: 'identity-role', source: 'reflection', text: 'Ashutosh is a software engineer and security researcher with published CVEs, currently looking for roles in the European Union that offer visa sponsorship.' },

    // --- projects -------------------------------------------------------------
    { id: 'proj-furlpay', source: 'voice-note', text: 'FurlPay is his payments product. The corporate actions engine keeps projection pure so it can never credit cash directly; settlement is a separate step with an idempotency key.' },
    { id: 'proj-furlpay-deploy', source: 'voice-note', text: 'FurlPay deploys to Vercel from the web project, manually rather than on push, and the production domain is furlpay.com.' },
    { id: 'proj-guardian', source: 'reflection', text: 'Guardian is the Wear OS companion for FurlPay, written in Kotlin, covering both the phone and the watch surfaces.' },
    { id: 'proj-jarvis', source: 'voice-note', text: 'Jarvis is the local-first desktop assistant. Everything runs on the machine: speech recognition, the language model, embeddings, and vision.' },
    { id: 'proj-crunchdao', source: 'reflection', text: 'He competes in CrunchDAO challenges, currently the obesity prediction problem and the structural break detection problem.' },

    // --- events with dates and people -----------------------------------------
    { id: 'meet-nico', source: 'phone-WhatsApp', text: 'Nico Reinhardt asked for a follow-up on the settlement latency numbers before the end of the month. He is the integrations lead at the payments partner.' },
    { id: 'meet-standup', source: 'voice-note', text: 'The team standup moved to nine fifteen in the morning on Tuesdays and Thursdays, because the earlier slot clashed with the partner call.' },
    { id: 'meet-review', source: 'phone-WhatsApp', text: 'Priya scheduled the architecture review for the eighteenth, and asked that the ledger migration document be circulated two days beforehand.' },
    { id: 'meet-interview', source: 'voice-note', text: 'The interview with the Amsterdam company is on the fourth at two in the afternoon, and they confirmed they sponsor the highly skilled migrant permit.' },

    // --- speech-damaged storage (STT wrote these wrong) ------------------------
    { id: 'stt-hotspot', source: 'voice-note', text: 'When the home network drops he tethers to the Redmi Note ten pro hotspot, the profile is already saved so it connects without a password.' },
    { id: 'stt-earbuds', source: 'voice-note', text: 'The one plus buds three disconnect the microphone whenever audio switches profile, so the laptop mic with earbuds output is the stable combination.' },

    // --- technical detail, rare tokens ----------------------------------------
    { id: 'tech-ports', source: 'document', text: 'Local services bind to loopback: speech recognition on port 8770, the model runtime on 11434, and the optional OCR server on 10000.' },
    { id: 'tech-decimals', source: 'document', text: 'Token decimals are verified on chain before decoding an amount, because reading a six decimal token as eighteen understates a four million dollar transfer by a factor of a trillion.' },
    { id: 'tech-aggregation', source: 'document', text: 'An arbitrage transaction routes the same tokens through several pools, so transfers are grouped per transaction; otherwise one movement is announced once per hop.' },
    { id: 'tech-keccak', source: 'document', text: 'The namehash implementation uses a pure keccak-256 with Ethereum padding of 0x01, not the SHA3 padding of 0x06, and is verified against public test vectors.' },
    { id: 'tech-vad', source: 'document', text: 'The endpointing hangover is one and a half seconds of silence, which is why a sub-second spoken response time is arithmetically impossible on this pipeline.' },

    // --- near-duplicate distractors, one decisive difference -------------------
    { id: 'dup-alpaca', source: 'document', text: 'Market quotes come from Alpaca when the key is present in the vault, and the request goes to the trades latest endpoint.' },
    { id: 'dup-yahoo', source: 'document', text: 'Market quotes come from the keyless Yahoo chart endpoint when no broker key is stored, which is the default path.' },
    { id: 'dup-eth-ws', source: 'document', text: 'The Ethereum stream subscribes to new block headers over a websocket, and heads arrive roughly twelve seconds apart.' },
    { id: 'dup-arb-ws', source: 'document', text: 'Arbitrum produces blocks in well under a second, which is precisely why streaming is limited to Ethereum by default.' },

    // --- background noise -----------------------------------------------------
    { id: 'noise-weather', source: 'voice-note', text: 'It rained heavily through the afternoon and the balcony door was left open.' },
    { id: 'noise-groceries', source: 'voice-note', text: 'Buy rice, lentils, and cooking oil on the way back from the office.' },
    { id: 'noise-film', source: 'voice-note', text: 'The documentary about deep sea whales was worth watching, particularly the section on migration routes.' },
    { id: 'noise-gym', source: 'voice-note', text: 'Gym sessions are Monday, Wednesday, and Friday evenings after seven.' },
    { id: 'noise-book', source: 'voice-note', text: 'Finished the book on distributed systems, the chapter on consensus was the useful part.' },
];

/**
 * Each question names the ONE document that answers it. `kind` records why the
 * question is here, so a failure points at a mechanism rather than a mystery.
 */
export const QUESTIONS = [
    // literal — the words are in the document
    { q: 'which browser does he use', answer: 'pref-browser', kind: 'literal' },
    { q: 'what port does speech recognition use', answer: 'tech-ports', kind: 'literal' },
    { q: 'when is the architecture review', answer: 'meet-review', kind: 'literal' },
    { q: 'what is FurlPay', answer: 'proj-furlpay', kind: 'literal' },
    { q: 'when are gym sessions', answer: 'noise-gym', kind: 'literal' },

    // paraphrase — little or no lexical overlap, dense should carry these
    { q: 'does he prefer a light or dark interface', answer: 'pref-theme', kind: 'paraphrase' },
    { q: 'what does he drink in the morning', answer: 'pref-coffee', kind: 'paraphrase' },
    { q: 'is he allowed to work in europe', answer: 'identity-role', kind: 'paraphrase' },
    { q: 'why can the assistant not answer instantly when spoken to', answer: 'tech-vad', kind: 'paraphrase' },
    { q: 'why is only one blockchain watched live', answer: 'dup-arb-ws', kind: 'paraphrase' },
    { q: 'what happens if a token amount is decoded with the wrong precision', answer: 'tech-decimals', kind: 'paraphrase' },

    // rare proper nouns — embeddings blur names, lexical should carry these
    { q: 'who is Nico', answer: 'meet-nico', kind: 'proper-noun' },
    { q: 'what did Priya ask for', answer: 'meet-review', kind: 'proper-noun' },
    { q: 'what is Guardian', answer: 'proj-guardian', kind: 'proper-noun' },
    { q: 'what is CrunchDAO', answer: 'proj-crunchdao', kind: 'proper-noun' },
    { q: 'what does keccak use for padding', answer: 'tech-keccak', kind: 'proper-noun' },

    // speech-damaged — the query is clean, the stored text is mangled
    { q: 'how does he get internet when the wifi fails', answer: 'stt-hotspot', kind: 'stt-damage' },
    { q: 'why do his earbuds break the microphone', answer: 'stt-earbuds', kind: 'stt-damage' },

    // near-duplicate — two documents are similar, one decisive detail decides
    { q: 'where do quotes come from without a broker key', answer: 'dup-yahoo', kind: 'near-duplicate' },
    { q: 'which quote source needs a key in the vault', answer: 'dup-alpaca', kind: 'near-duplicate' },
    { q: 'how far apart do ethereum blocks arrive', answer: 'dup-eth-ws', kind: 'near-duplicate' },

    // multi-hop-ish — the answer is one document but the phrasing routes around it
    { q: 'what should I send before the eighteenth', answer: 'meet-review', kind: 'indirect' },
    { q: 'who needed a follow up from me', answer: 'meet-nico', kind: 'indirect' },
    { q: 'what time is the tuesday meeting', answer: 'meet-standup', kind: 'indirect' },
    { q: 'when is my amsterdam interview', answer: 'meet-interview', kind: 'indirect' },
    { q: 'why are transfers grouped together', answer: 'tech-aggregation', kind: 'indirect' },
    { q: 'where does the payments product get deployed', answer: 'proj-furlpay-deploy', kind: 'indirect' },
    { q: 'what runs entirely on my own machine', answer: 'proj-jarvis', kind: 'indirect' },
    { q: 'does he format code automatically when saving', answer: 'pref-editor', kind: 'indirect' },
];

/**
 * Memory benchmark: a scripted stream of observations, then questions about
 * what SHOULD have survived. Includes the failure this store was built for —
 * a single speech-recognition mangling must never become a durable belief.
 */
export const MEMORY_SCRIPT = [
    // A genuine preference, said more than once over time.
    { pass: 1, source: 'voice', facts: [{ attribute: 'primary browser', value: 'Chrome', statement: 'He uses Chrome as his primary browser.', prob: 0.9 }] },
    { pass: 2, source: 'voice', facts: [{ attribute: 'primary browser', value: 'Chrome', statement: 'Chrome is his main browser.', prob: 0.85 }] },
    { pass: 3, source: 'text', facts: [{ attribute: 'primary browser', value: 'Chrome', statement: 'He browses with Chrome.', prob: 0.9 }] },

    // Speech garble, heard once and never again. Must be rejected.
    { pass: 1, source: 'voice', facts: [{ attribute: 'interest', value: 'Uruguay events', statement: 'He is interested in events in Uruguay.', prob: 0.9 }] },
    { pass: 2, source: 'voice', facts: [{ attribute: 'experiment', value: 'loopstrand', statement: 'He is running an experiment called loopstrand.', prob: 0.88 }] },

    // A real preference that later CHANGES. The old value must not survive.
    { pass: 2, source: 'voice', facts: [{ attribute: 'editor', value: 'Sublime', statement: 'He edits code in Sublime Text.', prob: 0.8 }] },
    { pass: 3, source: 'voice', facts: [{ attribute: 'editor', value: 'Sublime', statement: 'Sublime is his editor.', prob: 0.8 }] },
    { pass: 4, source: 'text', facts: [{ attribute: 'editor', value: 'VS Code', statement: 'He has switched to VS Code.', prob: 0.9 }] },
    { pass: 5, source: 'correction', facts: [{ attribute: 'editor', value: 'VS Code', statement: 'His editor is VS Code.', prob: 0.95 }] },
    { pass: 6, source: 'text', facts: [{ attribute: 'editor', value: 'VS Code', statement: 'He works in VS Code daily.', prob: 0.9 }] },

    // Typed facts: a stronger source, should need less corroboration.
    { pass: 3, source: 'text', facts: [{ attribute: 'timezone', value: 'IST', statement: 'He works in Indian Standard Time.', prob: 0.95 }] },
    { pass: 4, source: 'text', facts: [{ attribute: 'timezone', value: 'IST', statement: 'His timezone is IST.', prob: 0.95 }] },
];

/** What the belief store should hold once the script has run. */
export const MEMORY_EXPECTATIONS = [
    { attribute: 'primary browser', shouldBeDurable: true, value: 'Chrome', why: 'said three times across two sources' },
    { attribute: 'editor', shouldBeDurable: true, value: 'VS Code', why: 'revised: the newer value must win and the old one must be evicted' },
    { attribute: 'timezone', shouldBeDurable: true, value: 'IST', why: 'typed twice — a stronger source than speech' },
    { attribute: 'interest', shouldBeDurable: false, why: 'heard once, never corroborated — speech garble' },
    { attribute: 'experiment', shouldBeDurable: false, why: 'heard once, never corroborated — speech garble' },
];
