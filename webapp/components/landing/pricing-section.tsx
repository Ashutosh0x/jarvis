"use client";

import { ArrowRight, Check, Download, ShieldCheck } from "lucide-react";
import {
  PLATFORMS,
  VERSION,
  REPO_URL,
  NPM_URL,
  NPM_PACKAGE,
  RELEASE_URL,
  CHECKSUMS_URL,
} from "@/lib/links";
import { PLATFORM_ICONS } from "./platform-icons";

/* What each platform card lists under the download buttons. Kept beside the
   platform data rather than inside lib/links, which describes where files are,
   not what they do. */
const HIGHLIGHTS = [
  "Voice control + screen reading",
  "Cognitive memory + reflection",
  "Live Android mirror + control",
  "Live finance & quant analytics",
  "Keyless on-chain reads + ENS",
];

export function PricingSection() {
  return (
    <section id="pricing" className="relative py-32 lg:py-40 border-t border-foreground/10">
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        {/* Header */}
        <div className="max-w-3xl mb-16">
          <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase block mb-6">
            Download
          </span>
          <h2 className="font-display text-5xl md:text-6xl lg:text-7xl tracking-tight text-foreground mb-6">
            Free. And it
            <br />
            <span className="text-stroke">stays free.</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl">
            No subscription, no accounts, no metered usage. It runs on your
            machine, so there is nothing to bill.
          </p>
          <p className="mt-6 font-mono text-xs text-muted-foreground">
            <a
              href={RELEASE_URL}
              className="underline underline-offset-4 hover:text-foreground transition-colors"
            >
              v{VERSION}
            </a>
            {" — Windows, macOS and Linux"}
          </p>
        </div>

        {/* Platform downloads */}
        <div className="grid md:grid-cols-3 gap-px bg-foreground/10">
          {PLATFORMS.map((platform) => {
            const Icon = PLATFORM_ICONS[platform.id];
            const primary = platform.downloads.find((d) => d.primary) ?? platform.downloads[0];
            const rest = platform.downloads.filter((d) => d !== primary);

            return (
              <div key={platform.id} className="relative p-8 lg:p-10 bg-background flex flex-col">
                <div className="mb-8">
                  <Icon className="w-8 h-8 text-foreground mb-5" />
                  <h3 className="font-display text-3xl text-foreground">{platform.name}</h3>
                  <p className="text-sm text-muted-foreground mt-2">{platform.requirement}</p>
                </div>

                <div className="mb-8 pb-8 border-b border-foreground/10">
                  <div className="flex items-baseline gap-2">
                    <span className="font-display text-5xl text-foreground">Free</span>
                    <span className="text-muted-foreground">forever</span>
                  </div>
                </div>

                <ul className="space-y-3 mb-10">
                  {HIGHLIGHTS.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                      <span className="text-sm text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>

                {/* The primary artifact, then the alternatives. `download` asks
                    the browser to save rather than navigate. */}
                <div className="mt-auto space-y-3">
                  <a
                    href={primary.href}
                    download
                    className="w-full py-4 px-4 flex items-center justify-center gap-2 text-sm font-medium bg-foreground text-primary-foreground hover:bg-foreground/90 transition-all group"
                  >
                    <Download className="w-4 h-4" />
                    {primary.label}
                    {/* `~` because the size is measured on one release and
                        carried forward — see the note in lib/links.ts. */}
                    <span className="font-mono text-xs opacity-60">~{primary.size}</span>
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                  </a>

                  {rest.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {rest.map((d) => (
                        <a
                          key={d.href}
                          href={d.href}
                          download
                          className="flex-1 min-w-[calc(50%-0.25rem)] py-2.5 px-3 text-center text-xs font-mono border border-foreground/20 text-muted-foreground hover:border-foreground hover:text-foreground transition-colors"
                          title={`${d.label} — ~${d.size}`}
                        >
                          {d.label}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Package managers + provenance */}
        <div className="mt-px grid md:grid-cols-2 gap-px bg-foreground/10">
          <div className="bg-background p-8 lg:p-10">
            <h3 className="font-display text-2xl text-foreground mb-3">Install from npm</h3>
            <p className="text-sm text-muted-foreground mb-5">
              Ships the same app plus the search engine as an importable library.
              It sets itself up on first run and adds a{" "}
              <code className="font-mono text-xs text-foreground">jarvis</code>{" "}
              command to your terminal.
            </p>
            <pre className="font-mono text-xs text-foreground bg-foreground/5 border border-foreground/10 p-4 overflow-x-auto mb-5">
              <code>npm install -g {NPM_PACKAGE}</code>
            </pre>
            <a
              href={NPM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-foreground group"
            >
              View on npm
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
            </a>
          </div>

          <div className="bg-background p-8 lg:p-10">
            <h3 className="font-display text-2xl text-foreground mb-3">Build it yourself</h3>
            <p className="text-sm text-muted-foreground mb-5">
              Full Electron and Node source, the Android companion in Kotlin, MIT
              licensed. No telemetry and no accounts, which you can check rather
              than take on trust.
            </p>
            <pre className="font-mono text-xs text-foreground bg-foreground/5 border border-foreground/10 p-4 overflow-x-auto mb-5">
              <code>git clone {REPO_URL}.git</code>
            </pre>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-foreground group"
            >
              View on GitHub
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
            </a>
          </div>
        </div>

        {/* Bottom Note */}
        <div className="mt-12 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">
            Ollama and two local models are fetched on first run — the app installs
            them for you.{" "}
            <a
              href="/documentation"
              className="underline underline-offset-4 hover:text-foreground transition-colors"
            >
              Read the setup guide
            </a>
          </p>
          {/* Stated plainly, because an unsigned build makes Windows and macOS
              warn on first launch and a surprise there reads as malware. */}
          <p className="flex items-center justify-center gap-2 font-mono text-xs text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5" />
            Builds are unsigned — verify them with{" "}
            <a
              href={CHECKSUMS_URL}
              className="underline underline-offset-4 hover:text-foreground transition-colors"
            >
              SHA256SUMS
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
