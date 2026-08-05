#!/usr/bin/env node
/* Merge the quant / HFT universe into data/named-companies.source.json.
   Names, country hints and — where a name is ambiguous — a city to search
   with. Nothing here is a coordinate; the resolver proves those. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'named-companies.source.json');

/* [name, country, query?]  — query overrides the SEARCH string only; the name
   check still validates against `name`. A city is the cheapest disambiguator
   there is, and these are names like "Radix" and "Maven" that collide. */
const FIRMS = [
    // ── US market makers and proprietary trading ────────────────────────────
    ['Two Sigma Securities', 'USA', 'Two Sigma Securities New York'],
    ['XR Trading', 'USA', 'XR Trading Chicago'],
    ['Transmarket Group', 'USA', 'TransMarket Group Chicago'],
    ['Eagle Seven', 'USA', 'Eagle Seven Chicago'],
    ['Geneva Trading', 'USA', 'Geneva Trading Chicago'],
    ['Marquette Partners', 'USA', 'Marquette Partners Chicago'],
    ['Nico Trading', 'USA', 'Nico Trading Chicago'],
    ['Consolidated Trading', 'USA', 'Consolidated Trading Chicago'],
    ['Simplex Trading', 'USA', 'Simplex Trading Chicago'],
    ['Spot Trading', 'USA', 'Spot Trading Chicago'],
    ['DV Trading', 'USA', 'DV Trading Chicago'],
    ['Valkyrie Trading', 'USA', 'Valkyrie Trading Chicago'],
    ['Blue Fire Capital', 'USA', 'Blue Fire Capital Chicago'],
    ['Prime Trading', 'USA', 'Prime Trading Chicago'],
    ['Aardvark Trading', 'USA', 'Aardvark Trading Chicago'],
    ['Allston Trading', 'USA', 'Allston Trading Chicago'],
    ['Walleye Capital', 'USA', 'Walleye Capital New York'],
    ['Cutler Group', 'USA', 'Cutler Group San Francisco'],
    ['Volant Trading', 'USA', 'Volant Trading New York'],
    ['Teza Technologies', 'USA', 'Teza Technologies Chicago'],
    ['Vatic Labs', 'USA', 'Vatic Labs New York'],
    ['Kershner Trading Group', 'USA', 'Kershner Trading Austin'],
    ['Tradebot Systems', 'USA', 'Tradebot Systems Kansas City'],
    ['Sculptor Capital', 'USA', 'Sculptor Capital New York'],
    ['Matrix Executions', 'USA', 'Matrix Executions New York'],

    // ── quant hedge funds ──────────────────────────────────────────────────
    ['Renaissance Technologies', 'USA', 'Renaissance Technologies East Setauket'],
    ['D. E. Shaw', 'USA', 'D. E. Shaw New York'],
    ['AQR Capital Management', 'USA', 'AQR Capital Greenwich'],
    ['Millennium Management', 'USA', 'Millennium Management New York'],
    ['Point72 Asset Management', 'USA', 'Point72 Stamford'],
    ['Citadel', 'USA', 'Citadel LLC Miami'],
    ['Bridgewater Associates', 'USA', 'Bridgewater Associates Westport'],
    ['PDT Partners', 'USA', 'PDT Partners New York'],
    ['Voleon Group', 'USA', 'Voleon Berkeley'],
    ['WorldQuant', 'USA', 'WorldQuant Old Greenwich'],
    ['Schonfeld Strategic Advisors', 'USA', 'Schonfeld New York'],
    ['Balyasny Asset Management', 'USA', 'Balyasny Chicago'],
    ['ExodusPoint Capital', 'USA', 'ExodusPoint New York'],
    ['Verition Fund Management', 'USA', 'Verition Greenwich'],
    ['Graham Capital Management', 'USA', 'Graham Capital Rowayton'],
    ['Campbell and Company', 'USA', 'Campbell and Company Baltimore'],
    ['Crabel Capital Management', 'USA', 'Crabel Capital Milwaukee'],
    ['Quest Partners', 'USA', 'Quest Partners New York'],
    ['Hutchin Hill', 'USA', 'Hutchin Hill New York'],
    ['Coatue Management', 'USA', 'Coatue New York'],

    // ── Europe ─────────────────────────────────────────────────────────────
    ['Da Vinci Derivatives', 'Netherlands', 'Da Vinci Derivatives Amsterdam'],
    ['All Options', 'Netherlands', 'All Options Amsterdam'],
    ['Webb Traders', 'Netherlands', 'Webb Traders Amsterdam'],
    ['Nyenburgh Holding', 'Netherlands', 'Nyenburgh Amsterdam'],
    ['Scientific Trading', 'Netherlands', 'Scientific Trading Amsterdam'],
    ['Mako Group', 'UK', 'Mako Group London'],
    ['GSA Capital', 'UK', 'GSA Capital London'],
    ['Marshall Wace', 'UK', 'Marshall Wace London'],
    ['Man Group', 'UK', 'Man Group London'],
    ['Winton Group', 'UK', 'Winton London'],
    ['Squarepoint Capital', 'UK', 'Squarepoint Capital London'],
    ['Aspect Capital', 'UK', 'Aspect Capital London'],
    ['Florin Court Capital', 'UK', 'Florin Court London'],
    ['Systematica Investments', 'Switzerland', 'Systematica Investments Geneva'],
    ['Capital Fund Management', 'France', 'Capital Fund Management Paris'],
    ['Quantica Capital', 'Switzerland', 'Quantica Capital Zurich'],
    ['Transtrend', 'Netherlands', 'Transtrend Rotterdam'],
    ['Lynx Asset Management', 'Sweden', 'Lynx Asset Management Stockholm'],
    ['Brevan Howard', 'UK', 'Brevan Howard London'],
    ['Liquid Capital', 'UK', 'Liquid Capital London'],
    ['Susquehanna International Securities', 'Ireland', 'Susquehanna Dublin'],
    ['Virtu Financial Ireland', 'Ireland', 'Virtu Financial Dublin'],

    // ── APAC ───────────────────────────────────────────────────────────────
    ['Eclipse Trading', 'Hong Kong', 'Eclipse Trading Hong Kong'],
    ['Grasshopper Asia', 'Singapore', 'Grasshopper Singapore'],
    ['Vivienne Court Trading', 'Australia', 'Vivienne Court Sydney'],
    ['Tibra Capital', 'Australia', 'Tibra Capital Sydney'],
    ['Optiver Asia Pacific', 'Australia', 'Optiver Sydney'],
    ['IMC Asia Pacific', 'Australia', 'IMC Sydney'],
    ['Akuna Capital Sydney', 'Australia', 'Akuna Capital Sydney'],
    ['Jump Trading Singapore', 'Singapore', 'Jump Trading Singapore'],
    ['Jane Street Hong Kong', 'Hong Kong', 'Jane Street Hong Kong'],
    ['Citadel Securities Hong Kong', 'Hong Kong', 'Citadel Securities Hong Kong'],
    ['Hudson River Trading Singapore', 'Singapore', 'Hudson River Trading Singapore'],
    ['XTX Markets Singapore', 'Singapore', 'XTX Markets Singapore'],
    ['WorldQuant Singapore', 'Singapore', 'WorldQuant Singapore'],
    ['Millennium Singapore', 'Singapore', 'Millennium Management Singapore'],
    ['Optiver Japan', 'Japan', 'Optiver Tokyo'],
    ['Jane Street Japan', 'Japan', 'Jane Street Tokyo'],

    // ── China ──────────────────────────────────────────────────────────────
    ['High-Flyer Quant', 'China', 'High-Flyer Hangzhou'],
    ['Ubiquant Investment', 'China', 'Ubiquant Beijing'],
    ['Nine Chapters Capital', 'China', 'Nine Chapters Capital Beijing'],
    ['Minghong Investment', 'China', 'Minghong Investment Shanghai'],
    ['Lingjun Investment', 'China', 'Lingjun Investment Shanghai'],
    ['Ruitian Capital', 'China', 'Ruitian Capital Shanghai'],
    ['Baiont Quant', 'China', 'Baiont Nanjing'],
    ['Century Frontier', 'China', 'Century Frontier Shanghai'],

    // ── India ──────────────────────────────────────────────────────────────
    ['Graviton Research Capital', 'India', 'Graviton Research Capital Gurugram'],
    ['Quadeye Securities', 'India', 'Quadeye Gurugram'],
    ['AlphaGrep Securities', 'India', 'AlphaGrep Securities Mumbai'],
    ['NK Securities Research', 'India', 'NK Securities Research Delhi'],
    ['iRage Capital Advisory', 'India', 'iRage Capital Mumbai'],
    ['Estee Advisors', 'India', 'Estee Advisors Gurugram'],
    ['Dolat Capital', 'India', 'Dolat Capital Mumbai'],
    ['Futures First', 'India', 'Futures First Gurugram'],
    ['Open Futures', 'India', 'Open Futures Delhi'],
    ['Tower Research Capital India', 'India', 'Tower Research Capital Gurugram'],
    ['WorldQuant India', 'India', 'WorldQuant Mumbai'],
    ['D. E. Shaw India', 'India', 'D. E. Shaw Hyderabad']
];

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const have = new Set(src.companies.map((c) => c.name.toLowerCase()));
let added = 0;
for (const [name, country, query] of FIRMS) {
    if (have.has(name.toLowerCase())) continue;
    const row = { name, country, category: 'quant-hft' };
    if (query) row.query = query;
    src.companies.push(row);
    added++;
}
fs.writeFileSync(SRC, JSON.stringify(src, null, 2));
console.log(`added ${added} quant/HFT firms — list is now ${src.companies.length}`);
