"use client";

import { useEffect, useRef, useState } from "react";

const features = [
  {
    number: "01",
    title: "Voice in, voice out",
    description: "JARVIS listens continuously and answers by speech. Recognition runs on faster-whisper locally, and it reads your screen with Gemma 3 vision — no microphone or capture ever leaves the machine.",
    visual: "deploy",
  },
  {
    number: "02",
    title: "Memory that learns",
    description: "A cognitive memory that turns conversations into durable knowledge. Hybrid retrieval, a belief store with confidence and provenance, and a nightly reflection pass that consolidates what it has learned about you.",
    visual: "ai",
  },
  {
    number: "03",
    title: "Does the work, not just the talking",
    description: "Say it and it happens. Files and folders written where you asked, code authored by Gemma straight into a new file and opened in your editor, alarms and timers that survive a restart — every path and filename decided by rule, never by a model.",
    visual: "collab",
  },
  {
    number: "04",
    title: "Aware of your day",
    description: "Connect Google Calendar and JARVIS keeps track. It asks what to call a meeting and what it is about, then schedules it with a Meet link. Warnings escalate as the hour approaches — thirty minutes, ten, five, one — rather than repeating the same reminder until you stop hearing it.",
    visual: "ai",
  },
  {
    number: "05",
    title: "Android companion",
    description: "Pair your phone over Wi-Fi and control JARVIS from anywhere in the room. The same voice interface, plus phone battery, notifications, and device actions relayed securely over a local WebSocket link.",
    visual: "collab",
  },
  {
    number: "06",
    title: "Your phone, on your desktop",
    description: "Say \"mirror my phone\" and its live screen appears, with touch and keyboard control. H.264 straight off the device, decoded on the GPU — 1080×2400 at 60 fps, first frame in under a second. Nothing is installed on the phone, and the session leaves no trace when it ends.",
    visual: "mirror",
  },
  {
    number: "07",
    title: "A globe that answers",
    description: "Say \"show me Tokyo\" and the orb becomes a command centre — a dark sphere of glowing amber coastlines, a pin on the target, landmarks on leader lines, live earthquake ripples. Country, state, city, street or building all resolve, and the camera framing is derived from the measured extent of the place rather than a table of zoom levels.",
    visual: "globe",
  },
  {
    number: "08",
    title: "Private by design",
    description: "No hosted model, no model API keys, no conversation data leaving your disk. Outbound traffic is limited to live-data lookups — a search, a quote, a block — each carrying only the subject of the question. Per-query cost is zero.",
    visual: "security",
  },
];

function DeployVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full">
      <defs>
        <clipPath id="deployClip">
          <rect x="30" y="20" width="140" height="120" rx="4" />
        </clipPath>
      </defs>
      
      {/* Container */}
      <rect x="30" y="20" width="140" height="120" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
      
      {/* Animated bars */}
      <g clipPath="url(#deployClip)">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <rect
            key={i}
            x="40"
            y={35 + i * 16}
            width="120"
            height="10"
            rx="2"
            fill="currentColor"
            opacity="0.15"
          >
            <animate
              attributeName="opacity"
              values="0.15;0.8;0.15"
              dur="2s"
              begin={`${i * 0.15}s`}
              repeatCount="indefinite"
            />
            <animate
              attributeName="width"
              values="20;120;20"
              dur="2s"
              begin={`${i * 0.15}s`}
              repeatCount="indefinite"
            />
          </rect>
        ))}
      </g>
      
      {/* Progress indicator */}
      <circle cx="100" cy="155" r="3" fill="currentColor" opacity="0.3">
        <animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

function AIVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full">
      {/* Central node */}
      <circle cx="100" cy="80" r="12" fill="currentColor">
        <animate attributeName="r" values="12;14;12" dur="2s" repeatCount="indefinite" />
      </circle>
      
      {/* Orbiting nodes */}
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const angle = (i * 60) * (Math.PI / 180);
        const radius = 50;
        // Round to a fixed precision so the server and client serialize these
        // coordinates identically (avoids a React hydration mismatch on floats).
        const cx = Number((100 + Math.cos(angle) * radius).toFixed(3));
        const cy = Number((80 + Math.sin(angle) * radius).toFixed(3));
        return (
          <g key={i}>
            {/* Connection line */}
            <line
              x1="100"
              y1="80"
              x2={cx}
              y2={cy}
              stroke="currentColor"
              strokeWidth="1"
              opacity="0.3"
            >
              <animate
                attributeName="opacity"
                values="0.3;0.8;0.3"
                dur="2s"
                begin={`${i * 0.3}s`}
                repeatCount="indefinite"
              />
            </line>

            {/* Outer node */}
            <circle
              cx={cx}
              cy={cy}
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <animate
                attributeName="r"
                values="6;8;6"
                dur="2s"
                begin={`${i * 0.3}s`}
                repeatCount="indefinite"
              />
            </circle>
          </g>
        );
      })}
      
      {/* Pulse rings */}
      <circle cx="100" cy="80" r="30" fill="none" stroke="currentColor" strokeWidth="1" opacity="0">
        <animate attributeName="r" values="20;60" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

function CollabVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full">
      {/* User A */}
      <g>
        <rect x="30" y="50" width="50" height="60" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <text x="55" y="85" textAnchor="middle" fontSize="20" fontFamily="monospace" fill="currentColor">A</text>
        <circle cx="55" cy="35" r="12" fill="none" stroke="currentColor" strokeWidth="2" />
      </g>
      
      {/* User B */}
      <g>
        <rect x="120" y="50" width="50" height="60" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <text x="145" y="85" textAnchor="middle" fontSize="20" fontFamily="monospace" fill="currentColor">B</text>
        <circle cx="145" cy="35" r="12" fill="none" stroke="currentColor" strokeWidth="2" />
      </g>
      
      {/* Connection */}
      <line x1="80" y1="80" x2="120" y2="80" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4">
        <animate attributeName="stroke-dashoffset" values="0;-8" dur="0.5s" repeatCount="indefinite" />
      </line>
      
      {/* Data packet */}
      <circle r="4" fill="currentColor">
        <animateMotion dur="1.5s" repeatCount="indefinite">
          <mpath href="#dataPath" />
        </animateMotion>
      </circle>
      <path id="dataPath" d="M 80 80 L 120 80" fill="none" />
      
      {/* Sync indicator */}
      <g transform="translate(100, 130)">
        <circle r="6" fill="none" stroke="currentColor" strokeWidth="2">
          <animate attributeName="r" values="6;10;6" dur="1s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
  );
}

function SecurityVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full">
      {/* Shield */}
      <path
        d="M 100 20 L 150 40 L 150 90 Q 150 130 100 145 Q 50 130 50 90 L 50 40 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      
      {/* Inner shield */}
      <path
        d="M 100 35 L 135 50 L 135 85 Q 135 115 100 128 Q 65 115 65 85 L 65 50 Z"
        fill="currentColor"
        opacity="0.1"
      >
        <animate attributeName="opacity" values="0.1;0.2;0.1" dur="2s" repeatCount="indefinite" />
      </path>
      
      {/* Lock icon */}
      <rect x="85" y="70" width="30" height="25" rx="3" fill="currentColor" />
      <path
        d="M 90 70 L 90 60 Q 90 50 100 50 Q 110 50 110 60 L 110 70"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      
      {/* Keyhole */}
      <circle cx="100" cy="80" r="4" fill="white" />
      <rect x="98" y="82" width="4" height="8" fill="white" />
      
      {/* Scan lines */}
      <line x1="60" y1="60" x2="140" y2="60" stroke="currentColor" strokeWidth="1" opacity="0">
        <animate attributeName="y1" values="40;120;40" dur="3s" repeatCount="indefinite" />
        <animate attributeName="y2" values="40;120;40" dur="3s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0;0.5;0" dur="3s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}

/* A phone streaming frames to a desktop, and control travelling back — the
   two directions of the mirror, which is the thing worth showing. */
function MirrorVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full">
      {/* Phone, drawn at a real handset aspect (20:9) because that shape is
          what the panel is sized from. */}
      <rect x="18" y="34" width="42" height="92" rx="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="32" y1="41" x2="46" y2="41" stroke="currentColor" strokeWidth="2" opacity="0.5" />
      <rect x="24" y="49" width="30" height="66" rx="2" fill="currentColor" opacity="0.12">
        <animate attributeName="opacity" values="0.12;0.3;0.12" dur="2.4s" repeatCount="indefinite" />
      </rect>

      {/* Desktop panel, the same picture at the same aspect */}
      <rect x="118" y="26" width="62" height="108" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="124" y="32" width="50" height="96" rx="2" fill="currentColor" opacity="0.12">
        <animate attributeName="opacity" values="0.12;0.3;0.12" dur="2.4s" begin="0.35s" repeatCount="indefinite" />
      </rect>

      {/* Frames travelling phone -> desktop */}
      {[0, 1, 2].map((i) => (
        <rect key={`f${i}`} x="66" y="62" width="10" height="6" rx="1" fill="currentColor" opacity="0">
          <animate attributeName="x" values="66;108" dur="1.5s" begin={`${i * 0.5}s`} repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;0.9;0" dur="1.5s" begin={`${i * 0.5}s`} repeatCount="indefinite" />
        </rect>
      ))}

      {/* Touch and keys travelling desktop -> phone */}
      {[0, 1].map((i) => (
        <circle key={`c${i}`} cx="108" cy="98" r="2.5" fill="currentColor" opacity="0">
          <animate attributeName="cx" values="108;66" dur="1.5s" begin={`${0.25 + i * 0.75}s`} repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;0.9;0" dur="1.5s" begin={`${0.25 + i * 0.75}s`} repeatCount="indefinite" />
        </circle>
      ))}

      <line x1="64" y1="80" x2="114" y2="80" stroke="currentColor" strokeWidth="1" opacity="0.2" strokeDasharray="3 3" />
    </svg>
  );
}

function GlobeVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full">
      {/* The sphere, drawn as the graticule rather than as a filled ball —
          the real globe is vectors lit from within, not a rendered planet. */}
      <circle cx="100" cy="80" r="52" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="100" cy="80" r="52" fill="currentColor" opacity="0.06" />

      {/* Meridians: ellipses narrowing towards the limb, which is what
          longitude lines actually do on a sphere seen face-on. */}
      {[52, 34, 16].map((rx, i) => (
        <ellipse key={`m${i}`} cx="100" cy="80" rx={rx} ry="52" fill="none"
          stroke="currentColor" strokeWidth="1" opacity="0.28" />
      ))}
      {/* Parallels */}
      {[-34, -17, 0, 17, 34].map((dy, i) => {
        const ry = Math.sqrt(Math.max(0, 52 * 52 - dy * dy));
        return (
          <line key={`p${i}`} x1={100 - ry} y1={80 + dy} x2={100 + ry} y2={80 + dy}
            stroke="currentColor" strokeWidth="1" opacity="0.28" />
        );
      })}

      {/* Concentric ripples at a live event */}
      {[0, 1, 2].map((i) => (
        <circle key={`r${i}`} cx="78" cy="62" r="3" fill="none"
          stroke="currentColor" strokeWidth="1.5" opacity="0">
          <animate attributeName="r" values="3;18" dur="3s" begin={`${i}s`} repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;0" dur="3s" begin={`${i}s`} repeatCount="indefinite" />
        </circle>
      ))}

      {/* Pin on the target, with its leader line and label rule */}
      <line x1="122" y1="52" x2="150" y2="34" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <line x1="150" y1="34" x2="184" y2="34" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <circle cx="122" cy="52" r="3.5" fill="currentColor">
        <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

function AnimatedVisual({ type }: { type: string }) {
  switch (type) {
    case "deploy":
      return <DeployVisual />;
    case "ai":
      return <AIVisual />;
    case "collab":
      return <CollabVisual />;
    case "mirror":
      return <MirrorVisual />;
    case "globe":
      return <GlobeVisual />;
    case "security":
      return <SecurityVisual />;
    default:
      return <DeployVisual />;
  }
}

function FeatureCard({ feature, index }: { feature: typeof features[0]; index: number }) {
  const [isVisible, setIsVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.2 }
    );

    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={cardRef}
      className={`group relative transition-all duration-700 ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-12"
      }`}
      style={{ transitionDelay: `${index * 100}ms` }}
    >
      <div className="flex flex-col lg:flex-row gap-8 lg:gap-16 py-12 lg:py-20 border-b border-foreground/10">
        {/* Number */}
        <div className="shrink-0">
          <span className="font-mono text-sm text-muted-foreground">{feature.number}</span>
        </div>
        
        {/* Content */}
        <div className="flex-1 grid lg:grid-cols-2 gap-8 items-center">
          <div>
            <h3 className="text-3xl lg:text-4xl font-display mb-4 group-hover:translate-x-2 transition-transform duration-500">
              {feature.title}
            </h3>
            <p className="text-lg text-muted-foreground leading-relaxed">
              {feature.description}
            </p>
          </div>
          
          {/* Visual */}
          <div className="flex justify-center lg:justify-end">
            <div className="w-48 h-40 text-foreground">
              <AnimatedVisual type={feature.visual} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FeaturesSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.1 }
    );

    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      id="features"
      ref={sectionRef}
      className="relative py-24 lg:py-32"
    >
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header */}
        <div className="mb-16 lg:mb-24">
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
            <span className="w-8 h-px bg-foreground/30" />
            Capabilities
          </span>
          <h2
            className={`text-4xl lg:text-6xl font-display tracking-tight transition-all duration-700 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            Everything on your machine.
            <br />
            <span className="text-muted-foreground">Nothing in the cloud.</span>
          </h2>
        </div>

        {/* Features List */}
        <div>
          {features.map((feature, index) => (
            <FeatureCard key={feature.number} feature={feature} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}
