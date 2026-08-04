#!/usr/bin/env node
/**
 * Jarvis Foundry command line.
 *
 *   node scripts/foundry.mjs doctor            what is present, what is missing, what it costs
 *   node scripts/foundry.mjs install           fetch a portable Blender from blender.org
 *   node scripts/foundry.mjs render "<text>"   the whole path: sentence -> image
 *   node scripts/foundry.mjs build <spec.json> skip the model, build a spec directly
 *
 * `doctor` reports measurements, not expectations. Every line it prints was
 * read from the machine at the moment it ran — that is the point of it, and it
 * is why it is the first thing to run when something looks wrong.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { locateBlender, installPortable, resolveSource, runtimeRoot } from '../src/js/services/foundry/blenderRuntime.js';
import { probeRuntime, createFromUtterance, PLANNER_MODEL } from '../src/js/services/foundry/foundryService.js';
import { runSpec, workspaceRoot } from '../src/js/services/foundry/blenderBridge.js';
import { validateSpec } from '../src/js/services/foundry/sceneSpec.js';
import { REQUIRED_ENV } from '../src/js/services/foundry/kvBudget.js';

const GiB = 1024 ** 3;
const gib = (n) => (n === null || n === undefined ? '?' : `${(n / GiB).toFixed(2)} GiB`);

const [, , command = 'doctor', ...rest] = process.argv;

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function doctor() {
    console.log('Jarvis Foundry — state of this machine\n');

    /* --- Blender --- */
    const blender = await locateBlender();
    if (blender.found) {
        console.log(`  Blender runtime    ${blender.version}  ${blender.path}`);
    } else {
        console.log('  Blender runtime    MISSING');
        for (const t of blender.tried) console.log(`                     tried ${t.path} — ${t.reason}`);
        console.log('                     fix: node scripts/foundry.mjs install');
    }

    const source = resolveSource();
    console.log(`  Blender source     ${(await exists(source)) ? source : 'not present'}`);
    console.log('                     (read for API verification; it contains no executable)');

    /* --- Ollama and the KV budget --- */
    const runtime = await probeRuntime();
    console.log('');
    if (!runtime.reachable) {
        console.log(`  Planner model      UNREACHABLE — ${runtime.error}`);
    } else {
        console.log(`  Planner model      ${runtime.model}  ${runtime.parameterSize ?? '?'}  ${runtime.quantization ?? '?'}`);
        if (runtime.shape) {
            const s = runtime.shape;
            console.log(`  Attention shape    ${s.layers} layers, ${s.kvHeads} KV heads, head dim ${s.keyLength}${s.slidingWindow ? `, sliding window ${s.slidingWindow}` : ''}`);
        } else {
            console.log('  Attention shape    unknown — the model file does not publish it, so no budget can be computed');
        }
        console.log(`  Loaded now         ${runtime.loaded ? `yes, ${gib(runtime.sizeVram ?? runtime.size)} resident` : 'no (weights would be read from disk on the next command)'}`);
    }

    /* --- the two environment variables that decide the cache --- */
    console.log('');
    const fa = process.env.OLLAMA_FLASH_ATTENTION ?? null;
    const kv = process.env.OLLAMA_KV_CACHE_TYPE ?? null;
    console.log(`  OLLAMA_FLASH_ATTENTION   ${fa ?? 'unset'}`);
    console.log(`  OLLAMA_KV_CACHE_TYPE     ${kv ?? 'unset'}`);
    if (runtime.kvQuantisationActive) {
        console.log('  KV quantisation          ACTIVE');
    } else if (kv && kv !== 'f16' && fa !== '1') {
        console.log('  KV quantisation          INACTIVE — the cache type is set but flash attention is not.');
        console.log('                           Ollama only quantises the cache on the flash-attention path,');
        console.log('                           so this setting is currently doing nothing.');
    } else {
        console.log('  KV quantisation          off (f16 cache)');
    }

    if (runtime.budget) {
        const b = runtime.budget;
        console.log('');
        console.log(`  KV cost              ${(b.perTokenBytes / 1024).toFixed(1)} KiB per token at ${b.cacheType}`);
        console.log(`  Free for cache       ${gib(b.freeForCache)}`);
        console.log(`  Largest context      ${b.maxContext} tokens`);
        for (const note of b.notes) console.log(`                       ${note}`);
    }

    /* --- what to set, if it is not set --- */
    if (!runtime.kvQuantisationActive) {
        console.log('\n  To enable KV cache quantisation (persists across reboots):');
        for (const [k, v] of Object.entries(REQUIRED_ENV)) {
            console.log(`    setx ${k} ${v}`);
        }
        console.log('    then restart the Ollama server so it picks them up.');
    }

    console.log(`\n  Workspace          ${workspaceRoot()}`);
    console.log(`  Runtime root       ${runtimeRoot()}`);

    const ready = blender.found && runtime.reachable;
    console.log(`\n  Ready to render    ${ready ? 'yes' : 'NO — see the missing items above'}`);
    process.exit(ready ? 0 : 1);
}

async function install() {
    console.log('Fetching a portable Blender from blender.org.\n');
    let lastPercent = -1;
    const result = await installPortable({
        onProgress: (e) => {
            if (e.phase === 'downloading' && e.percent !== undefined) {
                if (e.percent !== lastPercent) { lastPercent = e.percent; process.stdout.write(`\r  downloading ${e.percent}%   `); }
            } else if (e.phase === 'downloading') {
                console.log(`  downloading ${e.detail}`);
            } else {
                console.log(`\n  ${e.phase}${e.detail ? `: ${e.detail}` : ''}`);
            }
        }
    });
    console.log(`\n  Blender ${result.version} installed at ${result.path}`);
    console.log(`  ${result.verification}`);
}

async function render(text) {
    if (!text) { console.error('usage: foundry.mjs render "<what to build>"'); process.exit(2); }
    console.log(`Request: ${text}\n`);
    const result = await createFromUtterance(text, { onStatus: (s) => console.log(`  ${s}`) });

    console.log('');
    if (!result.ok) {
        console.log(`  FAILED at stage: ${result.stage}`);
        console.log(`  ${result.error}`);
        if (result.errors) for (const e of result.errors) console.log(`    - ${e}`);
        if (result.hint) console.log(`  ${result.hint}`);
        if (result.attempts) console.log(`  ${JSON.stringify(result.attempts, null, 2).slice(0, 1500)}`);
        if (result.stdout) console.log(`  --- blender output (tail) ---\n${result.stdout.split('\n').slice(-25).join('\n')}`);
        process.exit(1);
    }

    console.log(`  image      ${result.image}`);
    console.log(`  objects    ${result.build.objects.join(', ')} (${result.build.polygons} polygons)`);
    console.log(`  engine     ${result.build.engine}  device: ${result.build.device}`);
    for (const w of result.build.warnings || []) console.log(`  warning    ${w}`);
    for (const e of result.exports || []) console.log(`  export     ${e.format}  ${e.path}  ${e.bytes} bytes`);
    if (result.printability) {
        console.log(`  printable  ${result.printability.watertight ? 'yes — watertight' : 'NO — see below'}`);
        for (const m of result.printability.meshes) {
            if (!m.printable) console.log(`             ${m.name}: ${m.non_manifold_edges} non-manifold edges, ${m.loose_edges} loose edges, ${m.loose_vertices} loose vertices`);
        }
    }
    console.log(`  render     ${result.seconds}s in Blender, ${result.wallSeconds}s wall`);
    if (result.planning?.promptEvalCount !== null && result.planning?.promptEvalCount !== undefined) {
        console.log(`  planning   ${result.planning.promptEvalCount} prompt tokens evaluated in ${result.planning.promptEvalDurationMs}ms`);
    }
}

async function build(specPath) {
    if (!specPath) { console.error('usage: foundry.mjs build <spec.json>'); process.exit(2); }
    const spec = JSON.parse(await fs.readFile(path.resolve(specPath), 'utf8'));
    const validation = validateSpec(spec);
    if (!validation.ok) {
        console.log('The specification is not valid:');
        for (const e of validation.errors) console.log(`  - ${e}`);
        process.exit(1);
    }
    const result = await runSpec(validation.spec, { onProgress: (l) => console.log(`  ${l}`) });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
}

const commands = { doctor, install, render: () => render(rest.join(' ')), build: () => build(rest[0]) };
const handler = commands[command];
if (!handler) {
    console.error(`unknown command "${command}". Try: ${Object.keys(commands).join(', ')}`);
    process.exit(2);
}
handler().catch((e) => { console.error(`\n${e.stack || e.message}`); process.exit(1); });
