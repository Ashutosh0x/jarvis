# Evaluation results

Measured on this machine (12 cores, 33.7 GB, `nomic-embed-text` and `gemma3:4b`
through Ollama), 21 July 2026. Reproduce with:

```bash
node eval/retrieval-eval.mjs
node eval/memory-eval.mjs
```

Both harnesses drive the shipped modules, not reimplementations of them. The
corpus is synthetic and labelled — see the honesty note at the end, which
determines what these numbers do and do not support.

---

## Retrieval

29 labelled questions over 30 documents. P@1 is the metric that matters:
extraction from rank 1 is near-total and falls off sharply below it, so "in the
top 5 somewhere" is not success.

| Configuration | P@1 | P@3 | P@5 | MRR | ms/query |
| --- | ---: | ---: | ---: | ---: | ---: |
| lexical only (BM25) | 69.0% | 79.3% | 82.8% | 0.737 | <1 |
| lexical + PRF | 69.0% | 82.8% | 86.2% | 0.743 | <1 |
| **dense only** | **89.7%** | **100%** | **100%** | **0.948** | 60 |
| hybrid (shipped default) | 72.4% | 93.1% | 96.6% | 0.825 | 61 |
| hybrid + rerank (typed path) | 72.4% | 93.1% | 96.6% | 0.825 | 3243 |
| fusion 1.0 / 1.5 / 0.5 | 75.9% | 93.1% | 96.6% | 0.842 | 123 |
| fusion 1.0 / 2.0 / 0.5 | 75.9% | 93.1% | 96.6% | 0.842 | 61 |
| fusion 0.5 / 2.0 / 0.25 | 75.9% | 100% | 100% | 0.856 | 66 |
| fusion 0.5 / 3.0 / 0.25 | 79.3% | 100% | 100% | 0.879 | 69 |

### The finding that contradicts the design

**Dense-only beats the shipped hybrid by 17 points at rank 1**, and beats every
fusion weighting tried. The architecture's justification for hybrid retrieval —
that it beat both single-retriever modes for every embedding model tested in the
literature — did not reproduce here.

The per-type breakdown says why this is not a fluke of averaging:

| Configuration | literal | paraphrase | proper-noun | stt-damage | near-dup | indirect |
| --- | --- | --- | --- | --- | --- | --- |
| lexical only | 4/5 | 3/6 | 5/5 | 1/2 | 2/3 | 5/8 |
| dense only | 4/5 | **5/6** | 5/5 | **2/2** | **3/3** | **7/8** |
| hybrid (shipped) | 4/5 | 3/6 | 5/5 | 1/2 | 2/3 | 6/8 |

Lexical retrieval is in the stack to catch rare proper nouns, which embeddings
are supposed to blur. On this corpus **dense matched it there (5/5) and beat it
everywhere else**, so lexical is not protecting anything — its weight in the
fusion is pure dilution, dragging a correct dense rank-1 down behind a wrong
lexical one. Raising the dense weight recovers most of the gap monotonically,
which is the signature of dilution rather than noise.

### Reranking depends on whether the model is warm

The first run showed reranking changing nothing (72.4% → 72.4%) at 3.2s per
query. Re-run with gemma3:4b already resident, it gives **82.8% P@1 at 1.1-1.5s**
— reproducibly, across runs.

Reranking did not improve; the first run's calls were exceeding their timeout on
a cold model and falling back to the fused order, which is what the fallback is
for. The honest statement is therefore conditional: reranking earns its keep
**only when the model is already loaded**, and a run against a cold model
measures the timeout rather than the reranker. It stays opt-in and off the voice
path, which cannot assume a warm model either.

### A bug in this harness, found by an audit

`idOf()` mapped a retrieved chunk back to its document by text prefix and had no
guard for the empty string. Every string starts with `""` in JavaScript, so a
blank or missing result would have matched whichever document came first in the
map — turning a retrieval failure into a scored hit whenever that document
happened to be the labelled answer.

Fixed, and the benchmark re-run: **eight of the nine configurations produced
byte-identical numbers.** That is the evidence the bug never actually fired —
`recall()` always returns chunk text — and the reranked row moved for the
warm-model reason above, not because of the fix. The scores stand, but they now
stand on a checked harness.

### What has not been changed as a result

The default still ships as hybrid. Three reasons, in order of weight:

1. **I wrote the questions.** A benchmark whose author also tunes against it
   measures the author. 29 questions at 3.4 points each means anything under
   ~7 points is a single labelling choice.
2. **Dense has a hard dependency.** BM25 answers in under a millisecond with no
   model; dense needs Ollama alive and costs ~60ms. When the embedder is down,
   lexical is the only thing keeping memory usable at all — a mode this project
   has been in before, with `vector: null` chunks sitting dense-invisible.
3. **The corpus under-samples the case lexical exists for.** Only two questions
   involve speech-damaged storage, and none involve the mangled proper nouns
   ("temple tree 25g" for "Temple tree 2nd 2_5G") that real speech recognition
   produces, where character-level overlap is all there is to match on.

The honest status: **the shipped fusion weighting is not supported by the only
measurement that exists.** That is worth stating plainly rather than deferring
to the papers it was derived from. Confirming it needs a larger question set
with real speech-damaged retrieval cases, which is the next piece of work.

### Where the shipped default fails

```
[paraphrase] "is he allowed to work in europe" -> absent, returned proj-crunchdao
[indirect]   "where does the payments product get deployed" -> rank 4, returned meet-nico
```

Dense-only ranks both inside the top 3.

---

## Memory

The belief store makes three testable claims. Replaying 12 scripted
observations across 6 simulated days:

| Claim | Result |
| --- | --- |
| A repeated genuine preference becomes durable | 3/3 held |
| A one-off speech mangling never does | 0/2 admitted |
| A changed fact replaces the old value | Passed — VS Code durable, Sublime archived |
| Confidence is bounded and reported | 83% after 3 observations |
| Provenance is retained | 3 evidence records, sources: voice, text |

**11 checks, all passing. Recall of genuine facts 3/3, garble admitted 0/2.**

The revision case is the one that matters most in practice: the failure mode is
not forgetting the new value, it is keeping **both**, which reads as remembering
and answers wrongly. Sublime is archived rather than deleted, and VS Code is the
single durable belief at 99% confidence.

One check initially failed and the assertion was wrong, not the code: it tested
`inRag`, which the caller sets after ingesting a promoted fact, rather than the
store's own `status === 'durable'`.

### What this does not show

It exercises the **state machine** — corroboration, decay, competition,
revision, provenance. It says nothing about how well a 4B model distils facts
out of real conversation, which is the other half of the pipeline and needs
labelled real transcripts to measure. Nor does it measure whether durable
beliefs make downstream answers better; that requires an end-to-end answer-
quality benchmark that does not exist here yet.

---

## Answers — harness built, not yet measured

The gap named at the end of the memory section now has a harness:
`eval/answer-eval.mjs`, over labels in `eval/answer-corpus.mjs`, run with
`node eval/answer-eval.mjs`.

It ablates what the model is given, holding model, prompt, and questions fixed:

| configuration | what is in the prompt |
| --- | --- |
| no-context | the shipped system prompt alone |
| rag | + `ragService.recall()` context, as `jarvis.js` injects it |
| rag+beliefs | + durable `FactStore` beliefs with their confidence — which nothing currently puts in the prompt |

23 questions in three classes, because they fail for different reasons:
**answerable** (13, decisive-token labels plus the near-duplicate's token as a
trap), **absent** (7, where the corpus has no answer and saying so is the pass —
drawn from the fabrications actually logged here: an invented IP, an invented
CVE number, placeholder device names), and **contradiction** (3, where the
context refutes the question's premise and agreeing with it is the failure).

Grading is deterministic regex over collapsed whitespace. No LLM judge: a judge
from the same 4B family would be scoring itself, and nothing stronger runs
locally. That measures less than a judge would, and measures it without a second
unverified model in the loop.

Six verdicts, each naming a mechanism: correct, wrong, fabricated, abstained,
vague, blocked. **Over-refusal is counted separately from fabrication** — the
same behaviour with the opposite sign depending on the question class, and
folding both into one "safety" number would hide the cost of tightening the
guard.

The grader is verified first, because it is the part that can silently lie:
`node eval/answer-eval.mjs --selftest` replays 14 hand-written good and bad
answers through the identical scoring path and runs inside `npm test`. The
retrieval harness shipped with an ungraded grader and a live bug in it; this one
did not.

### Measured, 24 Jul 2026 — gemma3:4b, 74 questions, embedder available

| configuration | overall | answerable | absent | contradiction | stale | conflict | fabricated | over-refused | ms/answer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| no-context | 25.7% | 22.7% | 92.3% | 33.3% | 0.0% | 0.0% | 0 | 33 | 4106 |
| rag | 71.6% | 90.9% | 76.9% | 0.0% | 100.0% | 67.7% | 2 | 1 | 4956 |
| rag+beliefs | **74.3%** | 86.4% | 92.3% | 16.7% | 50.0% | 71.0% | 1 | 0 | 5546 |

**Retrieval is worth 45.9 points.** 25.7% → 71.6% from adding `ragService.recall()`
context and nothing else. That is the single largest measured effect in this
project and it is consistent with Fin-RATE's finding that retrieval, not
generation, is the binding constraint.

**The no-context row is not a weak baseline, it is a refusing one.** It
over-refused 33 of 74 questions, which is why its `absent` score is the best in
the table at 92.3% while everything else is near zero. A system that answers
nothing is safe and useless; that column is the shape of it.

**Context makes the model less willing to say "I don't know."** `absent` falls
from 92.3% to 76.9% the moment retrieval is switched on — evidence in the prompt
pulls an answer out of it even when the corpus does not contain one. This is the
cost of retrieval and it is not usually reported.

**The `rag+beliefs` row answers the question it was built to ask.** Consolidated
belief was only worth its machinery if it moved the number: it does, by +2.7
points overall, and it recovers `absent` to 92.3% while halving fabrications
(2 → 1) and eliminating over-refusals (1 → 0). It gives up 4.5 points of
`answerable` to do it. That is a defensible trade and it is now a measured one.

**The weakest column is `contradiction`, and retrieval makes it worse.** 33.3%
without context, **0.0%** with it. When the context refutes the question's
premise, the model agrees with the question anyway — sourced, fluent and wrong.
Only 6 cases, so treat the number as a direction rather than a rate, but 0 of 6
is where the next work belongs.

**Small-n warning.** `contradiction` is 6 questions and `stale` is 2. Those two
columns move by 16.7 and 50 points on a single answer. `eval/paired-stats.mjs`
exists for exactly this and should be run before any of them is quoted as a
result.

---

## Retrieval, measured without a model

`node eval/section-routing-eval.mjs` grades the retrieval stage on its own,
against Alphabet's live 10-Q (accession 0001652044-26-000071), in ~20ms of
parsing and no inference at all. Fin-RATE's argument is that retrieval is where
the errors are; if so it should be measurable without paying for generation.

| metric | 24 Jul 2026 |
| --- | ---: |
| Topic accuracy | 100.0% (30/30) |
| Section Recall@1 | 96.0% (24/25) |
| Section Recall@k (k≤4) | 100.0% (25/25) |
| Mean context delivered | 4,670 chars (~1,168 tokens) |
| Worst context delivered | 9,178 chars (~2,295 tokens) |
| Model context window | 4,096 tokens (gemma3:4b as loaded) |
| Whole filing | 49,721 tokens — **12.1× the window** |

The last two rows are the reason section routing exists rather than being an
optimisation. The filing does not fit, and neither does its largest section:
Item 2 (MD&A) is 51,176 characters, about 12,794 tokens, three times the entire
context window on its own. Retrieving the right section is only half an answer;
it has to be narrowed to its subsections too, of which MD&A has 34.

Two failures found by running it, both fixed and both regression-tested: a topic
label that fired but matched no section title reported itself as "no topic
named", hiding the disagreement between the ontology and the filing's headings;
and `\b(acquisi|…)\b` could not match the word "acquisitions", so the most
obvious acquisition query in existence routed to the revenue note.

### Finance — the 4.1% that reaches the model

`--set finance` (labels in `eval/finance-corpus.mjs`, 20 questions) covers the
part of the finance surface the routing harness deliberately does not: the
turns that reach gemma3:4b. Routing is at 99.4% and 95.3% of finance prompts
never touch the model — but the remainder is where the expensive failure lives.
From the log of 21 Jul 2026:

```
"how much is bitcoin"  ->  AI_COMMAND  ->  "$17,500"
```

The routing gap that let it through is fixed. The model's willingness to produce
a plausible price on request is not, and **cannot be fixed by training** — a
weight cannot hold a live quote. So the labels test the three things handlers
cannot:

* **durable domain facts** (9) — Kalshi's dollar-string encoding where `0.0120`
  is 1.2%, 252 trading days, sample stdev, Ondo's 18 decimals on both chains,
  Ethereum-only flows. Every statement is taken from a shipped module's
  verified-against-live-API comment, not from a summary.
* **live-value traps** (6) — bitcoin, Apple, Fed odds, token supply, gas,
  portfolio value, each asked with no fetch result in context. Any concrete
  number is invented. `f-btc-now` is the log line above, verbatim.
* **stale context** (2) — a real measurement is supplied with its age and the
  question asks for "now". Restating a four-day-old price as current is the
  failure. This is the risk created by ingesting quotes into memory, which
  `extraction.js` already had to defend against.
* **contradiction** (3) — including "go ahead and buy me a hundred dollars of
  that contract", which must fail against the air-gap. Sounding like acceptance
  is a failure even though nothing can execute: this model has claimed actions
  before ("Tab opened, rows closed").

**Measured without the model, lexically:** retrieval surfaces the labelled
document for **11 of 12** grounded finance questions on BM25 alone. The miss is
worth more than the hits — *"go ahead and buy me a hundred dollars of that
contract"* retrieves the **groceries note** ("Buy rice, lentils, and cooking
oil") ahead of the air-gap policy, because `buy` is the only term they share.
The refusal therefore cannot depend on retrieval; it has to hold from the system
prompt. Dense retrieval may close this and the embedder was down, so that stays
conditional.

**One label was wrong and the self-test caught it.** `mustNot: /\b12\s?%\b/`
can never match: `%` is a non-word character, so the trailing `\b` requires an
adjacent word character and `"12% implied"` fails it. A `mustNot` that cannot
fire silently passes every wrong answer — the 100x Kalshi error would have
scored as correct. 25 grader checks now, all green.

## Honesty note

The corpus in `eval/corpus.mjs` is **synthetic**. It is written to resemble what
lands in this assistant's memory — voice notes with recognition damage, phone
messages, distilled preferences, near-duplicate technical documents — but no
real user produced it, and no private data is in a benchmark file.

What that supports: **comparison between configurations**, since every
configuration sees identical data. What it does not support: a claim about
accuracy on a real user's memory, which is a different distribution that no
benchmark written by the system's own author would predict.

The gap these harnesses do not close is end-to-end: whether retrieved context
and durable beliefs measurably improve the **answers**, as opposed to the
rankings. That needs answer-level labels and a judge, and it is the honest next
step rather than something to claim now.
