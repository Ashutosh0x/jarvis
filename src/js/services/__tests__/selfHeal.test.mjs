// Tests for the self-healing supervision layer.
//
// Each block below corresponds to a real failure in the interaction log for
// 21-30 Jul 2026, and asserts the property that would have prevented it:
//   * rag.rerank timed out 32/37 times against a fixed 6000ms budget -> budgets
//     must widen from observed behaviour, including from the timeouts themselves;
//   * that same dead reranker kept being called for eight days -> a dependency
//     that keeps failing must stop being paid for;
//   * Ollama went unresponsive without exiting -> health must come from a probe;
//   * the user was told "close some Chrome tabs" with 9GB free -> the diagnosis
//     must be read off the measurements.
import {
    AdaptiveBudget, CircuitBreaker, ServiceHealth, HealthRegistry,
    withHealing, diagnoseLocalFailure, slowestStage,
    CLOSED, OPEN, HALF_OPEN,
} from '../selfHeal.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/* ------------------------------------------------------------- budgets ---- */
{
    const b = new AdaptiveBudget({ min: 1000, max: 30000, initial: 6000, factor: 2 });

    check('budget: uses the seed until it has enough samples', b.value === 6000);
    b.record(1000); b.record(1000);
    check('budget: still seeded at two samples', b.value === 6000);

    b.record(1000);
    check('budget: three fast samples pull it down to p95*factor', b.value === 2000);

    // The motivating case: a call that really needs ~10s, budgeted at 6s.
    const slow = new AdaptiveBudget({ min: 1000, max: 30000, initial: 6000, factor: 2 });
    for (let i = 0; i < 5; i++) slow.recordTimeout(6000);
    check('budget: repeated timeouts widen the deadline past the old constant',
        slow.value > 6000);
    check('budget: widened deadline would admit a 10s call', slow.value >= 10000);

    const capped = new AdaptiveBudget({ min: 1000, max: 8000, initial: 4000, factor: 2 });
    for (let i = 0; i < 10; i++) capped.recordTimeout(8000);
    check('budget: never exceeds its ceiling', capped.value === 8000);
    check('budget: reports saturation at the ceiling', capped.saturated === true);

    const floor = new AdaptiveBudget({ min: 3000, max: 30000, initial: 5000, factor: 2 });
    floor.record(10); floor.record(10); floor.record(10);
    check('budget: never drops below its floor', floor.value === 3000);

    const win = new AdaptiveBudget({ min: 100, max: 99000, initial: 500, window: 3 });
    win.record(1000); win.record(1000); win.record(1000); win.record(200);
    check('budget: forgets samples beyond its window', win.samples.length === 3);

    const rt = new AdaptiveBudget({ min: 100, max: 99000, initial: 500 });
    rt.record(700); rt.record(800); rt.record(900);
    const saved = JSON.stringify(rt.toJSON());
    const restored = new AdaptiveBudget({ min: 100, max: 99000, initial: 500 })
        .load(JSON.parse(saved));
    check('budget: survives a round-trip through storage', restored.value === rt.value);
    check('budget: ignores corrupt persisted state',
        new AdaptiveBudget({ initial: 1234, min: 100, max: 9000 })
            .load({ samples: ['x', null, NaN] }).value === 1234);
    check('budget: rejects nonsense samples', (() => {
        const g = new AdaptiveBudget({ min: 100, max: 9000, initial: 500 });
        g.record(-5); g.record(NaN); g.record('slow');
        return g.samples.length === 0;
    })());
}

/* ------------------------------------------------------------ breakers ---- */
{
    let clock = 0;
    const c = new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: () => clock });

    check('breaker: starts closed and allows', c.state === CLOSED && c.allow() === true);
    c.onFailure(); c.onFailure();
    check('breaker: tolerates failures below the threshold',
        c.state === CLOSED && c.allow() === true);

    c.onFailure();
    check('breaker: opens on the third consecutive failure', c.state === OPEN);
    check('breaker: an open circuit costs nothing', c.allow() === false);

    clock = 999;
    check('breaker: stays open until the cooldown elapses', c.allow() === false);
    clock = 1000;
    check('breaker: lets one probe through after the cooldown', c.allow() === true);
    check('breaker: that probe is the half-open state', c.state === HALF_OPEN);

    c.onSuccess();
    check('breaker: a good probe closes the circuit', c.state === CLOSED);
    check('breaker: recovery needs no restart', c.allow() === true);

    // A dependency that is still down must back off, not retry every cooldown.
    let clock2 = 0;
    const d = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, maxCooldownMs: 8000, now: () => clock2 });
    d.onFailure();
    clock2 = 1000; d.allow(); d.onFailure();
    check('breaker: failed probe doubles the cooldown', d.cooldownMs === 2000);
    clock2 = 2000;
    check('breaker: honours the longer cooldown', d.allow() === false);
    clock2 = 3000; d.allow(); d.onFailure();
    check('breaker: keeps backing off', d.cooldownMs === 4000);
    for (let i = 0; i < 10; i++) { clock2 += 100000; d.allow(); d.onFailure(); }
    check('breaker: backoff is capped', d.cooldownMs === 8000);

    check('breaker: success resets the failure run', (() => {
        const e = new CircuitBreaker({ threshold: 3, now: () => 0 });
        e.onFailure(); e.onFailure(); e.onSuccess(); e.onFailure(); e.onFailure();
        return e.state === CLOSED;
    })());

    check('breaker: counts trips for telemetry', c.trips === 1);
    check('breaker: describes itself', /healthy/.test(c.describe()));
}

/* -------------------------------------------------------------- health ---- */
{
    // The 30 Jul shape: the probe fails while the process is perfectly alive.
    let alive = false, healed = 0, clock = 0;
    const s = new ServiceHealth({
        name: 'Ollama',
        probe: async () => alive,
        heal: async () => { healed++; alive = true; },
        failureThreshold: 2,
        healCooldownMs: 1000,
        now: () => clock,
    });

    await s.check();
    check('health: one failure is not yet unhealthy', s.healthy === true && healed === 0);
    await s.check();
    check('health: two consecutive failures trip it', s.healthy === false);
    check('health: healing runs without a process exit', healed === 1);

    await s.check();
    check('health: recovers once the probe passes', s.healthy === true);

    // Healing must be rate-limited or a slow-starting service is restarted
    // on top of itself forever.
    alive = false; clock = 0;
    const t = new ServiceHealth({
        name: 'x', probe: async () => false, heal: async () => { healed++; },
        failureThreshold: 1, healCooldownMs: 5000, now: () => clock,
    });
    healed = 0;
    await t.check(); await t.check(); await t.check();
    check('health: heals once inside the cooldown', healed === 1);
    clock = 5000;
    await t.check();
    check('health: heals again after the cooldown', healed === 2);

    const boom = new ServiceHealth({
        name: 'y', probe: async () => { throw new Error('ECONNREFUSED'); },
        failureThreshold: 1, now: () => 0,
    });
    await boom.check();
    check('health: a throwing probe counts as unhealthy, not a crash', boom.healthy === false);
    check('health: records why', /ECONNREFUSED/.test(boom.lastError));

    const badHeal = new ServiceHealth({
        name: 'z', probe: async () => false, heal: async () => { throw new Error('nope'); },
        failureThreshold: 1, now: () => 0,
    });
    await badHeal.check();
    check('health: a failing heal does not throw out of check()',
        /heal failed/.test(badHeal.lastError));
}

/* ------------------------------------------------------------- retries ---- */
{
    let calls = 0, heals = 0;
    const out = await withHealing(
        async () => { calls++; if (calls === 1) throw Object.assign(new Error('down'), { transient: true }); return 'ok'; },
        { heal: async () => { heals++; }, isTransient: (e) => e.transient === true },
    );
    check('retry: heals and retries a transient failure', out === 'ok' && calls === 2 && heals === 1);

    calls = 0;
    let threw = null;
    try {
        await withHealing(async () => { calls++; throw new Error('bad json'); },
            { isTransient: (e) => e.transient === true });
    } catch (e) { threw = e; }
    check('retry: does not retry a non-transient failure', calls === 1 && threw !== null);

    calls = 0;
    try {
        await withHealing(async () => { calls++; throw Object.assign(new Error('x'), { transient: true }); },
            { isTransient: () => true, retries: 2 });
    } catch { /* expected */ }
    check('retry: gives up after the retry budget', calls === 3);
}

/* --------------------------------------------------------- diagnostics ---- */
{
    // The exact case that produced eleven wrong messages on 30 Jul.
    const msg = diagnoseLocalFailure({
        stages: { intent: 4, 'rag.lexical': 0, 'rag.embed': 0, 'rag.rerank': 6001 },
        error: Object.assign(new Error('local model produced nothing in 25s'), { name: 'LocalTimeoutError' }),
        freeMemoryGb: 9.0,
    });
    check('diagnose: blames retrieval when retrieval was slow', /[Rr]etrieval/.test(msg));
    check('diagnose: does not invent memory pressure when memory is fine',
        !/memory|Chrome tabs/i.test(msg));

    const tight = diagnoseLocalFailure({
        stages: { 'llm.firstToken': 24000 },
        error: Object.assign(new Error('produced nothing'), { name: 'LocalTimeoutError' }),
        freeMemoryGb: 1.2,
    });
    check('diagnose: mentions memory only when it is genuinely low', /memory/i.test(tight));

    const dead = diagnoseLocalFailure({
        error: new Error('Failed to fetch'),
        health: { name: 'Ollama', healthy: false, healAttempts: 1 },
    });
    check('diagnose: a dead dependency outranks timing detail', /Ollama/.test(dead));
    check('diagnose: says it is already recovering', /restart/i.test(dead));

    check('diagnose: still refuses to invent an answer',
        /rather than an invented one/.test(diagnoseLocalFailure({ error: new Error('weird') })));

    check('slowestStage: ignores trivially fast stages',
        slowestStage({ intent: 4, 'rag.embed': 0 }) === null);
    check('slowestStage: picks the biggest', slowestStage({ a: 300, b: 9000 }).key === 'b');
    check('slowestStage: understands the {ms,calls} shape',
        slowestStage({ a: 300, b: { ms: 9000, calls: 3 } }).key === 'b');
    check('slowestStage: survives junk', slowestStage(null) === null);
}

/* ------------------------------------------------------------ registry ---- */
{
    const r = new HealthRegistry();
    const b1 = r.budget('rag.rerank', { min: 1000, max: 30000, initial: 6000 });
    const b2 = r.budget('rag.rerank');
    check('registry: returns the same budget for a name', b1 === b2);

    b1.record(4000); b1.record(4000); b1.record(4000);
    const snap = r.snapshot();
    check('registry: snapshot reports the learned value', snap.budgets['rag.rerank'].ms === 8000);

    r.breaker('rag.rerank', { threshold: 1, now: () => 0 }).onFailure();
    check('registry: snapshot reports breaker state',
        r.snapshot().breakers['rag.rerank'].state === OPEN);

    const r2 = new HealthRegistry();
    r2.budget('rag.rerank', { min: 1000, max: 30000, initial: 6000 });
    r2.load(JSON.parse(JSON.stringify(r.toJSON())));
    check('registry: learned budgets survive a restart',
        r2.budget('rag.rerank').value === 8000);
    check('registry: load tolerates missing state', r2.load(undefined) === r2);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
