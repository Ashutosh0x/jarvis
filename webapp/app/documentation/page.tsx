import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Documentation - JARVIS",
  description:
    "How JARVIS works in detail: architecture, the voice pipeline, hybrid retrieval, cognitive memory, deterministic finance and on-chain engines, and the Android companion.",
};

// ---------------------------------------------------------------------------
// Small presentational helpers (kept in-file so the docs are a single route).
// ---------------------------------------------------------------------------

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28 py-12 lg:py-16 border-b border-foreground/10">
      <span className="inline-flex items-center gap-3 text-xs font-mono uppercase tracking-widest text-muted-foreground mb-4">
        <span className="w-6 h-px bg-foreground/30" />
        {eyebrow}
      </span>
      <h2 className="text-3xl lg:text-5xl font-display tracking-tight mb-8">{title}</h2>
      <div className="space-y-5 text-lg text-muted-foreground leading-relaxed max-w-3xl">
        {children}
      </div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="not-prose my-6 max-w-3xl overflow-x-auto border border-foreground/10 bg-foreground/[0.02] rounded-lg">
      <pre className="p-5 font-mono text-sm leading-relaxed text-foreground/80">{children}</pre>
    </div>
  );
}

function Term({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[0.9em] text-foreground bg-foreground/[0.06] px-1.5 py-0.5 rounded">
      {children}
    </code>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="not-prose my-6 max-w-3xl overflow-x-auto border border-foreground/10 rounded-lg">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-foreground/10">
            {head.map((h) => (
              <th key={h} className="px-4 py-3 font-mono text-xs uppercase tracking-widest text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-foreground/5 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className={`px-4 py-3 align-top ${j === 0 ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const toc = [
  { id: "overview", label: "Overview" },
  { id: "architecture", label: "Architecture" },
  { id: "voice", label: "Voice pipeline" },
  { id: "supervision", label: "Process supervision" },
  { id: "retrieval", label: "Retrieval engine" },
  { id: "memory", label: "Cognitive memory" },
  { id: "evaluation", label: "Evaluation" },
  { id: "finance", label: "Finance & quant" },
  { id: "onchain", label: "On-chain reads" },
  { id: "whales", label: "Real-time whale stream" },
  { id: "issuance", label: "Stablecoin issuance" },
  { id: "providers", label: "Provider keys" },
  { id: "tracer", label: "Fund-flow tracer" },
  { id: "companion", label: "Android companion" },
  { id: "ports", label: "Network ports" },
  { id: "privacy", label: "Privacy model" },
  { id: "install", label: "Install & run" },
];

export default function DocumentationPage() {
  return (
    <main className="relative min-h-screen noise-overlay">
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-foreground/10">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-12 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            <ArrowLeft className="w-4 h-4 transition-transform group-hover:-translate-x-1" />
            <span className="font-display text-xl tracking-tight">JARVIS</span>
            <span className="text-muted-foreground font-mono text-xs mt-1">docs</span>
          </Link>
          <span className="hidden sm:inline font-mono text-xs text-muted-foreground uppercase tracking-widest">
            Technical reference
          </span>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-6 lg:px-12 grid lg:grid-cols-[240px_1fr] gap-12 lg:gap-16 py-12 lg:py-20">
        {/* Sidebar TOC */}
        <aside className="hidden lg:block">
          <nav className="sticky top-28 space-y-1">
            <span className="block font-mono text-xs uppercase tracking-widest text-muted-foreground mb-4">
              On this page
            </span>
            {toc.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="block py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <div>
          {/* Intro */}
          <div className="pb-8 border-b border-foreground/10">
            <h1 className="text-4xl lg:text-6xl font-display tracking-tight mb-6">
              How JARVIS works.
            </h1>
            <p className="text-xl text-muted-foreground leading-relaxed max-w-3xl">
              A complete technical walkthrough of the assistant — from the microphone,
              through intent routing and retrieval, to the deterministic engines that
              compute finance and on-chain answers. Everything below runs on your own
              machine. The guiding rule throughout: the language model never produces a
              number or a security verdict; deterministic, tested code does.
            </p>
          </div>

          <Section id="overview" eyebrow="01" title="What it is">
            <p>
              JARVIS is a desktop assistant whose intelligence runs entirely locally.
              Speech recognition, language understanding, retrieval, and vision all execute
              on your hardware. There are no model API keys, no calls to a hosted model
              provider, and no conversation data leaving the device.
            </p>
            <p>
              Some answers depend on facts only the outside world holds — a share price, a
              headline, the state of a blockchain. Those lookups send the subject of the
              question and nothing else: a ticker, an address, a search string. No
              transcript, no memory, no conversation. Everything else works with the network
              unplugged.
            </p>
            <p>
              It presents as a frameless, transparent 3D visualizer that floats above the
              desktop, listens continuously, and answers by voice. A companion Android app
              extends the same interface to a paired phone over Wi-Fi.
            </p>
            <Table
              head={["Capability", "Typical assistant", "JARVIS"]}
              rows={[
                ["Speech to text", "Cloud ASR", "faster-whisper, local"],
                ["Language model", "Hosted API", "Gemma 3 via Ollama, local"],
                ["Embeddings", "Hosted API", "nomic-embed-text, local"],
                ["Vision", "Cloud vision", "Gemma 3 multimodal, local"],
                ["Conversation storage", "Provider servers", "Local disk only"],
                ["Per-query cost", "Metered", "Zero"],
              ]}
            />
          </Section>

          <Section id="architecture" eyebrow="02" title="Architecture">
            <p>
              The app is split across the standard Electron process boundary, with all
              models running as local services on loopback. Nothing crosses a network
              except a keyless web search, and only when a query is search-shaped.
            </p>
            <Table
              head={["Layer", "Runs", "Responsibility"]}
              rows={[
                ["Renderer", "DOM + WebGL, no Node", "voice service, intent router, RAG, Three.js scene"],
                ["Main", "Electron, Node APIs", "service supervisor, IPC, companion bridge, ADB"],
                ["Local services", "loopback only", "faster-whisper, Ollama, Gemma 3, embeddings, OCR"],
                ["Companion", "over Wi-Fi", "Android app, WebSocket client"],
              ]}
            />
            <p>
              Intent routing is hybrid. Fast regular-expression matchers handle
              deterministic commands (open an app, set volume, read a price, a
              <Term>0x</Term> address). Anything left over is handed to Gemma 3 for a
              conversational answer, optionally grounded with retrieved memory, live
              telemetry, or web-search results.
            </p>
          </Section>

          <Section id="voice" eyebrow="03" title="The voice pipeline">
            <p>
              Audio flows from the microphone through an <Term>AudioContext</Term> graph
              (80&nbsp;Hz high-pass, compressor) into two branches: an analyser that drives
              the visualizer&apos;s FFT bands, and a PCM16 capture at 16&nbsp;kHz that feeds
              speech detection.
            </p>
            <p>
              An adaptive voice-activity gate keys on roughly 3× the measured noise floor,
              with a 320&nbsp;ms preroll and a 1.44&nbsp;s hangover so word endings are not
              clipped. Detected speech is transcribed by faster-whisper over a local
              WebSocket on port 8770.
            </p>
            <p>
              Two feedback loops are load-bearing and stop JARVIS from transcribing its own
              voice. A <Term>ttsActive</Term> flag gates the microphone while it speaks —
              but synthesized audio bypasses Chromium&apos;s echo cancellation, so that gate
              leaks. A second text-level echo guard catches what the gate misses by
              measuring word overlap (~60%) against recently spoken text; a match is dropped
              as self-talk.
            </p>
            <p>
              Replies stream: each completed sentence is spoken during token generation,
              cutting time-to-first-word from roughly 5–10&nbsp;s down to 1–2&nbsp;s.
            </p>
          </Section>

          <Section id="supervision" eyebrow="04" title="Process supervision">
            <p>
              On launch, the main process starts and monitors every local service. Two
              invariants govern how it treats Ollama specifically:
            </p>
            <p>
              <strong className="text-foreground">Only kill what you spawned.</strong>{" "}
              If an Ollama instance is already running, JARVIS reuses it and never kills it
              on quit. Only an instance it spawned itself is terminated.
            </p>
            <p>
              <strong className="text-foreground">Preload is not optional.</strong>{" "}
              Ollama&apos;s default <Term>keep_alive</Term> is five minutes, so without an
              explicit 60-minute preload the first question after any idle period would pay
              a multi-second cold load. JARVIS preloads the model with{" "}
              <Term>keep_alive: 60m</Term>.
            </p>
            <Table
              head={["Service", "Behaviour on failure"]}
              rows={[
                ["Ollama", "Reuse if present, else spawn, poll readiness, preload, respawn after 15s"],
                ["faster-whisper STT", "Auto-respawn after 15s; port conflicts exit harmlessly"],
                ["Companion bridge", "WebSocket server plus mDNS advertisement"],
                ["Downloads watcher", "New documents are OCR'd and ingested automatically"],
                ["Finance service", "60s quote cadence for the watchlist"],
              ]}
            />
          </Section>

          <Section id="retrieval" eyebrow="05" title="Retrieval engine">
            <p>
              Long-term memory is queried by a hybrid retriever in{" "}
              <Term>ragService.js</Term>. Every design choice is traceable to a measurement
              or a paper, not a guess.
            </p>
            <Table
              head={["Stage", "Implementation", "Why"]}
              rows={[
                ["Sparse", "BM25 over a persistent inverted index (k1 1.5, b 0.75)", "Re-tokenizing per query cost 105ms at 5k chunks"],
                ["Dense", "nomic-embed-text via Ollama, cosine, cutoff 0.3", "Falls back to BM25-only with no embedder"],
                ["Fusion", "Reciprocal Rank Fusion, k = 60", "Hybrid beat dense- and sparse-only in benchmarks"],
                ["Expansion", "Pseudo-relevance feedback, fused at weight 0.5", "A poor feedback pool can dilute but not corrupt"],
                ["Rerank", "Ambiguity-gated Gemma 3 rerank, opt-in", "Only when the top two are close; see below"],
                ["Selection", "IDF-weighted late sentence selection, budget 10", "Cuts context ~81% with byte-identical output"],
              ]}
            />
            <p>
              The inverted index is the single biggest win — top-10 rankings stay
              bit-identical to the naive scan while running hundreds of times faster:
            </p>
            <Table
              head={["Corpus", "Before", "After", "Speedup"]}
              rows={[
                ["500 chunks", "8.71 ms", "0.037 ms", "238×"],
                ["2,000 chunks", "37.1 ms", "0.116 ms", "319×"],
                ["5,000 chunks", "104.8 ms", "0.456 ms", "230×"],
              ]}
            />
            <p>
              Reranking is gated because a Gemma 3 rerank call costs ~3&nbsp;seconds. Typed
              input opts in; voice does not, because five seconds of added silence is
              unacceptable on the spoken path. Any timeout or malformed response falls back
              to lexical order, so reranking is an enhancement, never a dependency. Agentic
              (A-RAG) retrieval was evaluated and rejected purely on latency: 5–20 planning
              steps at ~3&nbsp;s each is 15–60&nbsp;s of silence before the first word.
            </p>
          </Section>

          <Section id="memory" eyebrow="06" title="Cognitive memory">
            <p>
              Memory has three layers. The <strong className="text-foreground">episodic</strong>{" "}
              log records every turn verbatim and append-only — the immutable source of
              truth. The <strong className="text-foreground">semantic</strong> layer is the
              hybrid RAG above. Between them sits a{" "}
              <strong className="text-foreground">belief store</strong> that turns raw
              experience into durable, corroborated facts.
            </p>
            <p>
              A reflection pass (the &quot;sleep&quot; consolidation) runs off the hot path — on an
              explicit <Term>reflect</Term> command or roughly once a day. It distills
              candidate facts, then runs them through a confidence gate so a one-off
              speech-to-text garble never pollutes memory. Facts must be corroborated across
              passes before they become durable, and they decay if not re-observed.
            </p>
            <p>
              Beliefs are probabilistic. New evidence merges with a noisy-OR update,
              weighted by source trust (a correction outweighs a typed statement, which
              outweighs a voice mis-hearing). Every belief carries an evidence trail, so the
              assistant can explain not just what it knows but why:
            </p>
            <Code>{`you  "what have you learned"

You use Chrome —
92% sure, from 3 confirmations
(2 voice, 1 text), last seen Jul 20`}</Code>
            <p>
              Every promotion, revision, and archive is appended to a memory audit log — a
              reviewable version history of how the assistant&apos;s beliefs evolved.
            </p>
          </Section>

          <Section id="evaluation" eyebrow="07" title="Evaluation">
            <p>
              Speed was measured here long before accuracy was, which is backwards: a fast
              ranker that puts the wrong passage first is worse than a slow one that does
              not. Two harnesses now measure the parts that were previously only asserted,
              and both drive the shipped modules rather than a reimplementation — a
              benchmark that rebuilds the ranker measures the rebuild.
            </p>
            <Table
              head={["Retrieval config", "P@1", "P@3", "MRR", "ms"]}
              rows={[
                ["lexical only (BM25)", "69.0%", "79.3%", "0.737", "<1"],
                ["dense only", "89.7%", "100%", "0.948", "60"],
                ["hybrid, as shipped", "72.4%", "93.1%", "0.825", "61"],
                ["hybrid + rerank", "72.4%", "93.1%", "0.825", "3,243"],
              ]}
            />
            <p>
              <strong className="text-foreground">The result contradicts the design.</strong>{" "}
              Dense-only beats the shipped hybrid by 17 points at rank 1, and beats every
              fusion weighting tried. Lexical retrieval is in the stack to catch rare proper
              nouns, which embeddings blur — but dense matched it there, 5 of 5, and beat it
              on every other question type. Its weight is diluting a better ranking rather
              than protecting a weakness. Reranking changed no answer at all while costing
              3.2 seconds per query.
            </p>
            <p>
              The default has not been changed on that basis, and the reasons are part of
              the result: the benchmark&apos;s author also wrote its questions, 29 questions
              makes anything under seven points a single labelling choice, and BM25 is the
              only thing that still retrieves when the embedder is down. The honest status
              is that the shipped weighting is <em>unsupported by the only measurement that
              exists</em> — which is more useful to know than the paper it was derived from.
            </p>
            <p>
              Memory is measured the same way: replaying scripted observations across
              simulated days, 3 of 3 genuine preferences became durable, 0 of 2
              speech-recognition manglings were admitted, and a changed fact replaced its
              predecessor rather than sitting beside it — the failure that reads as
              remembering and answers wrongly.
            </p>
            <p>
              What is deliberately <em>not</em> claimed: the corpus is synthetic, so these
              numbers compare configurations against each other, not against a real user&apos;s
              memory. And nothing here measures whether retrieved context improves the{" "}
              <em>answer</em> rather than the ranking. That needs answer-level labels and a
              judge, and until it exists the claim is not made.
            </p>
          </Section>

          <Section id="finance" eyebrow="08" title="Deterministic finance & quant">
            <p>
              The core rule: <strong className="text-foreground">the language model never
              computes a financial number.</strong> Sharpe ratios, volatility, drawdowns,
              betas, and option Greeks are exact math in a pure, exhaustively tested module.
              An LLM asked to &quot;estimate&quot; a Sharpe ratio will confidently get it wrong; this
              engine cannot.
            </p>
            <Code>{`// pure functions, no I/O, no clock — testable
sharpeRatio(returns, riskFree)   // (CAGR - rf) / annualized vol
annualizedReturn(returns)        // geometric CAGR, not arithmetic
maxDrawdown(prices)              // largest peak-to-trough decline
betaAlpha(asset, benchmark)      // vs the S&P 500
blackScholes(S, K, T, sigma, r)  // price + delta/gamma/vega/theta`}</Code>
            <p>
              Live quotes and history come from a keyless endpoint; the numbers are computed
              here, on real returns, with a 4% risk-free default. When a web search once
              claimed a stock was &quot;roughly flat,&quot; this engine — computing from the actual
              price series — correctly reported a 21% decline. That is the entire reason it
              exists: the model gave the wrong number, and the deterministic math gave the
              right one.
            </p>
          </Section>

          <Section id="onchain" eyebrow="09" title="On-chain reads">
            <p>
              The same rule applies to blockchain data: converting a wei balance to ETH, or
              a raw token amount to a human figure, is exact BigInt arithmetic — never an
              LLM estimate. Reads run over public JSON-RPC with per-chain endpoint failover
              across Ethereum, Arbitrum, Base, Optimism, Polygon, and BNB Chain, plus Solana
              when a key is present.
            </p>
            <p>
              It is strictly read-only. A hard method allowlist means the service can never
              be steered into a signing or state-changing call — there is no transaction
              construction anywhere in it.
            </p>
            <Table
              head={["Query", "What it does"]}
              rows={[
                ["gas on Arbitrum", "eth_gasPrice → gwei, formatted exactly"],
                ["balance of 0x…", "eth_getBalance → ETH via BigInt"],
                ["USDC balance of 0x…", "ERC-20 balanceOf, correct 6-decimal handling"],
                ["what standard is 0x…", "ERC-165 supportsInterface + metadata probe"],
                ["explain tx 0x…", "decode Transfer logs from the receipt"],
                ["who is vitalik.eth", "ENS namehash → resolver, both directions"],
                ["portfolio of vitalik.eth", "every holding across chains, priced"],
                ["which chains can you read", "answers from the startup probe, not a list"],
              ]}
            />
            <p>
              ENS is the one honest answer to &quot;who is this address&quot; — a name the owner set
              on-chain, verified with a real keccak-256 namehash, not a proprietary label or
              a guess. When an address has no ENS name, the assistant says exactly that
              rather than inventing an identity.
            </p>
            <p>
              Beyond a name, an address can be described only by what the chain proves about
              it: whether code lives there (<Term>eth_getCode</Term> — a contract or a
              key-controlled wallet), how many transactions it has sent, and what it holds.
              A nonce means &quot;transactions sent&quot; for a wallet but &quot;contracts deployed&quot; for a
              contract, so that figure is reported only where it means what it says.
            </p>
          </Section>

          <Section id="whales" eyebrow="10" title="Real-time whale stream">
            <p>
              A websocket subscription to new block headers. Every confirmed block is
              scanned for large movements, and every figure announced is read out of that
              block — there is no sampled feed, no cached digest, and no third-party alert
              service in the path.
            </p>
            <Code>{`newHeads ─┬─ eth_getBlockByNumber ─ native transfers >= 100 ETH
          └─ eth_getLogs ────────┬─ token transfers >= $1M
                                 └─ mints & burns (supply changes)
                    ↓
      aggregate per transaction → rank by measured USD → announce`}</Code>
            <p>
              <strong className="text-foreground">Tokens, not just ether.</strong> Most large
              value on Ethereum moves as stablecoins. Sampled across five live blocks: zero
              to two native ETH whales, against sixteen token movements. A native-only watch
              reports an unrepresentative slice of where money actually goes.
            </p>
            <p>
              <strong className="text-foreground">Decimals are verified on-chain</strong> with
              a <Term>decimals()</Term> call before any amount is decoded. Reading a
              six-decimal token as eighteen turns $4M into $4 — the class of bug that ends
              trust in financial software, so the token table has to prove itself at startup
              rather than being believed.
            </p>
            <p>
              <strong className="text-foreground">One transaction is one movement.</strong> An
              arbitrage route hops through several pools and emits the same tokens at each
              hop. A live drill caught the same 14,050 WETH being announced three times, as
              though $27M had moved three times. Transfers are now grouped per transaction:
              the source is the address that only sends, the destination the one that only
              receives, the amount is what actually left the source, and the hop count — or
              a round trip, where the money came back to where it started — is stated.
            </p>
            <p>
              <strong className="text-foreground">Ranked across assets by measured dollars.</strong>{" "}
              100 ETH has more raw units than 4,000,000 USDC. Ordering on units alone picks
              the wrong headline for the block, so a measured USD value decides, and an
              alert with no price is never ranked above one whose size is known.
            </p>
            <p>
              Alerts carry both ends: full addresses and the transaction hash on screen, ENS
              names and readable context in speech. Windowed recaps — &quot;whales in the last
              hour&quot; — are answered from what was actually recorded while watching, never a
              reconstruction after the fact.
            </p>
            <p>
              The stream is hardened for a machine that sleeps and changes networks:
              exponential backoff with jitter, a 30-second heartbeat with 90-second silence
              detection (heads arrive every ~12s, so silence <em>is</em> failure), block-gap
              detection with in-order backfill through the identical code path as live
              blocks, and bounded deduplication so memory stays flat. A disconnect drill on
              mainnet — socket killed mid-stream, 30 seconds down — detected exactly the two
              blocks confirmed during the outage, backfilled them in order, and produced no
              duplicates.
            </p>
          </Section>

          <Section id="issuance" eyebrow="11" title="Stablecoin issuance">
            <p>
              A mint is a transfer <em>from</em> the zero address; a burn is a transfer{" "}
              <em>to</em> it. That makes supply changes one of the few pieces of market
              intelligence that needs no label database and no trust in anyone&apos;s naming — it
              is how supply moves, visible to anyone reading the chain.
            </p>
            <p>
              Issuance rides the same per-block logs the whale scan already fetches, so it
              costs nothing extra while streaming. Verified against mainnet: a single
              5,414,317 USDC mint caught live, and across one hour DAI net +6.9M against USDC
              net −6.0M — including a 7.5M burn and a 7.5M mint in the same block, which is a
              peg-stability conversion rather than two unrelated events.
            </p>
            <p>
              What the chain does not record is <em>why</em>. The assistant reports that
              supply changed and where it landed; it does not narrate an issuer&apos;s intent.
            </p>
          </Section>

          <Section id="providers" eyebrow="12" title="Provider keys">
            <p>
              Every key is optional. Without any, JARVIS reads public endpoints and says so;
              with them, it sees more and still says exactly what it can and cannot reach.
            </p>
            <Table
              head={["Key", "Unlocks", "Without it"]}
              rows={[
                ["ALCHEMY_API_KEY", "Full wallet holdings with prices, keyed websocket", "Public RPC, known tokens only"],
                ["HELIUS_API_KEY", "Solana wallets, activity, stablecoin supply", "No Solana"],
                ["DUNE_API_KEY", "Aggregate analytics, top holders, priced flows", "Query states the key is needed"],
                ["ARKHAM_API_KEY", "Entity labels, spoken with attribution", "Addresses stay addresses"],
              ]}
            />
            <p>
              Networks are <strong className="text-foreground">discovered, not assumed</strong>.
              Each candidate endpoint has to return the chain ID it claims before anything is
              read from it, and an endpoint that answers for the wrong chain is discarded. On
              a free Alchemy tier this correctly rejects Optimism and Polygon — they answer
              403 — instead of failing later with a confusing error. A failed probe is kept
              as data, so &quot;why can&apos;t you read Polygon&quot; has a real answer.
            </p>
            <p>
              Provider limits shape the design rather than being discovered by users:
              Alchemy&apos;s free tier caps log queries at 10 blocks, 1rpc at 50, and drpc
              handles a few hundred until it rate-limits. Wide historical queries are
              therefore chunked at 50 blocks and raced across the keyless pool, and any chunk
              that fails is reported — &quot;nothing happened this hour&quot; and &quot;I could only read
              half the hour&quot; are different answers, and conflating them would be the kind of
              quiet dishonesty this project exists to avoid.
            </p>
            <p>
              Keys live in a <Term>.env</Term> file that is git-ignored, or in the encrypted
              vault. Values are never logged; startup prints only which names were found.
            </p>
          </Section>

          <Section id="tracer" eyebrow="13" title="Fund-flow tracer">
            <p>
              A deterministic fund-tracing engine implements the core of TRacer (KDD &apos;22):
              Approximate Personalized PageRank, forward-biased to follow where money goes.
              A cash-out point pools the funds that reach it, so it surfaces at the top of
              the ranking above dust and background noise — all graph math, no model.
            </p>
            <Code>{`traceFunds(edges, source)     // ranked downstream leads
detectCycles(graph, source)   // round-trip / U-turn patterns
coefficientOfVariation(amts)  // amount-consistency (layering)
detectConsistentChains(...)   // structurally coherent paths`}</Code>
            <p>
              It reports that a structure is <em>present</em> — it never claims &quot;this is
              money laundering.&quot; That verdict needs a trained model, labeled data, and a
              human analyst, none of which belong in a local assistant. Live tracing also
              needs an address&apos;s full transaction history, which public RPC cannot
              enumerate, so it activates only with a chain-explorer key you add to the
              encrypted vault.
            </p>
          </Section>

          <Section id="companion" eyebrow="14" title="Android companion">
            <p>
              The companion pairs over Wi-Fi and mirrors the same voice interface to a
              phone. Discovery is by mDNS; the link is a token-authenticated WebSocket with a
              constant-time token comparison. Capabilities are negotiated on connect, and
              control is tiered — routine actions are always available, while sensitive ones
              (curated wireless ADB) are opt-in and never expose a raw shell.
            </p>
            <p>
              Natural-language phone requests are parsed into structured intents before they
              cross the link, so the phone receives typed actions, not free text.
            </p>
          </Section>

          <Section id="ports" eyebrow="15" title="Network ports">
            <p>
              Every listener binds locally or to the LAN. None is exposed to the internet.
            </p>
            <Table
              head={["Port", "Service", "Bind", "Auth"]}
              rows={[
                ["8765", "Phone bridge HTTP", "0.0.0.0", "Bearer token (except pairing)"],
                ["8766", "Companion WebSocket", "0.0.0.0", "Token, constant-time compare"],
                ["8770", "faster-whisper STT", "127.0.0.1", "Loopback only"],
                ["11434", "Ollama", "127.0.0.1", "Loopback only"],
                ["10000", "Unlimited-OCR (optional)", "127.0.0.1", "Loopback only"],
              ]}
            />
          </Section>

          <Section id="privacy" eyebrow="16" title="Privacy model">
            <p>
              Privacy is the architecture, not a setting. Your microphone, screen captures,
              and conversations stay on local disk because there is no provider server to
              send them to. Every model binds to <Term>127.0.0.1</Term>.
            </p>
            <p>
              Outbound requests are limited to fact lookups that cannot be answered on your
              own disk: web search when a query is actually search-shaped, quote and news
              endpoints, and blockchain RPC. Each carries only the subject of the question.
              A whale alert is a public block being read; nothing about you is in that
              request.
            </p>
            <p>
              Optional secrets — provider and chain-explorer keys — live in a git-ignored{" "}
              <Term>.env</Term> file or sealed with OS-level encryption (DPAPI on Windows).
              They are never returned to the renderer and never written to a log; startup
              prints only which key <em>names</em> were found. Only main-process services
              consume them, and the endpoint URL that embeds a key is never handed to the
              interface layer.
            </p>
          </Section>

          <Section id="install" eyebrow="17" title="Install & run">
            <p>
              Clone the repository, install dependencies, and pull two local models. The
              whole assistant boots from one command.
            </p>
            <Code>{`git clone jarvis && cd jarvis
npm install

# pull the local models
ollama pull gemma3:4b
ollama pull nomic-embed-text

# optional: live-data provider keys, all optional
cp .env.example .env

# build and launch
npm run build
npm run electron`}</Code>
            <p>
              faster-whisper and Ollama start automatically, bound to loopback. Then just
              talk — no wake word, no menus. Try &quot;analyze Nvidia,&quot; &quot;gas on Arbitrum,&quot; &quot;who
              is vitalik.eth,&quot; &quot;what&apos;s on my screen,&quot; or &quot;reflect.&quot;
            </p>
            <p>
              For the market side: &quot;watch for whales&quot; starts the live stream, &quot;portfolio of
              vitalik.eth&quot; reads a wallet across chains, &quot;did Circle mint any USDC&quot; reads
              supply changes, and &quot;which chains can you read&quot; answers from what the startup
              probe actually verified.
            </p>
            <p>
              The test suite runs on plain <Term>node</Term> with no framework —{" "}
              <Term>npm test</Term> prints 987 checks across 27 suites, including routing
              tests that drive the real intent parser, because every routing bug this
              project has had ended as a confident, wrong answer rather than an error.
            </p>
          </Section>

          {/* Footer nav */}
          <div className="py-12">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
