"use client";

import { ArrowUpRight } from "lucide-react";
import { AnimatedWave } from "./animated-wave";
import {
  REPO_URL,
  NPM_URL,
  README_URL,
  LICENSE_URL,
  ISSUES_URL,
  RELEASES_URL,
} from "@/lib/links";

const footerLinks = {
  Product: [
    { name: "Features", href: "#features" },
    { name: "How it works", href: "#how-it-works" },
    { name: "Download", href: "#pricing" },
    { name: "The stack", href: "#integrations" },
  ],
  Capabilities: [
    { name: "Voice & vision", href: "#features" },
    { name: "Finance & quant", href: "#how-it-works" },
    { name: "On-chain reads", href: "#how-it-works" },
    { name: "Android companion", href: "#features" },
  ],
  // These four pointed at "#" — every one of them a link to nowhere on the
  // section of the page that exists to send people to the source.
  Project: [
    { name: "Source on GitHub", href: REPO_URL },
    { name: "npm package", href: NPM_URL },
    { name: "All releases", href: RELEASES_URL },
    { name: "README", href: README_URL },
    { name: "Report an issue", href: ISSUES_URL },
    { name: "License (MIT)", href: LICENSE_URL },
  ],
  Trust: [
    { name: "Privacy by design", href: "#security" },
    { name: "Runs offline", href: "#security" },
    { name: "No telemetry", href: "#security" },
  ],
};

const socialLinks = [
  { name: "GitHub", href: REPO_URL },
  { name: "npm", href: NPM_URL },
];

export function FooterSection() {
  return (
    <footer className="relative border-t border-foreground/10">
      {/* Animated wave background */}
      <div className="absolute inset-0 h-64 opacity-20 pointer-events-none overflow-hidden">
        <AnimatedWave />
      </div>
      
      <div className="relative z-10 max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Main Footer */}
        <div className="py-16 lg:py-24">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-12 lg:gap-8">
            {/* Brand Column */}
            <div className="col-span-2">
              <a href="#" className="inline-flex items-center gap-2 mb-6">
                <span className="text-2xl font-display">JARVIS</span>
                <span className="text-xs text-muted-foreground font-mono">local</span>
              </a>

              <p className="text-muted-foreground leading-relaxed mb-8 max-w-xs">
                A local-first desktop assistant. Speech, language, retrieval, and vision — all running on your own machine.
              </p>

              {/* Social Links */}
              <div className="flex gap-6">
                {socialLinks.map((link) => (
                  <a
                    key={link.name}
                    href={link.href}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 group"
                  >
                    {link.name}
                    <ArrowUpRight className="w-3 h-3 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                  </a>
                ))}
              </div>
            </div>

            {/* Link Columns */}
            {Object.entries(footerLinks).map(([title, links]) => (
              <div key={title}>
                <h3 className="text-sm font-medium mb-6">{title}</h3>
                <ul className="space-y-4">
                  {links.map((link) => (
                    <li key={link.name}>
                      <a
                        href={link.href}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-2"
                      >
                        {link.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="py-8 border-t border-foreground/10 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            JARVIS — local-first assistant. MIT licensed.
          </p>

          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              Runs 100% on your machine
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
