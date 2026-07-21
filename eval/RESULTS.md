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

Reranking changed nothing on this set (72.4% → 72.4%) while costing **3.2s per
query**. It is already opt-in and off the voice path; this is evidence for
leaving it that way, and for questioning it on the typed path too.

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
