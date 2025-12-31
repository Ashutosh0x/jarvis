# 👸 JARVIS — Neural Assistant & Audio Visualizer

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=three.js&logoColor=white" />
  <img src="https://img.shields.io/badge/Google%20Gemini-8E75C2?style=for-the-badge&logo=googlegemini&logoColor=white" />
</p>

**JARVIS** is a state-of-the-art, GPU-accelerated 3D audio visualizer and AI companion. Designed for speed, transparency, and high-fidelity interaction, JARVIS blends advanced web grounding with a stunning glossy UI to provide near-instant intelligence right on your desktop.

## 🚀 Key Features

- 🛰️ **Instant Search Grounding**: Real-time web retrieval via native Google Search grounding. No slow browser tabs—just facts, instantly.
- 🎨 **Neural Synthesis**: On-demand image generation and user "reimagining" with a persistent, non-intrusive side-HUD.
- 💎 **Translucent Visualizer**: A beautiful, frameless 3D Orb that floats over your desktop with true transparency.
- ⚡ **GPU Accelerated**: Optimized Three.js rendering at 60+ FPS without post-processing overhead.
- 👸 **Premium Voice Link**: High-quality "Aoede" voice profile for a professional, futuristic interaction experience.
- 🎙️ **Voice & Text Control**: Seamlessly switch between high-speed command line input and continuous live listening.

## 🛠️ Tech Stack

- **Core**: JavaScript (ES6+), Node.js
- **Desktop Framework**: [Electron](https://www.electronjs.org/)
- **Frontend Tools**: [Vite](https://vitejs.dev/)
- **3D Graphics**: [Three.js](https://threejs.org/)
- **Intelligence**: [Google Generative AI (Gemini 2.0 Flash)](https://ai.google.dev/)

## 📦 Getting Started

### Prerequisites

- Node.js (v18+)
- A Gemini API Key from [AI Studio](https://aistudio.google.com/)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/ashutosh0x/jarvis.git
   cd jarvis
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure API Keys**
   - Copy `src/config.example.js` to `src/config.js`
   - Add your Gemini API key and other optional keys.

4. **Run in Development**
   ```bash
   npm run dev            # Starts Vite
   npm run electron:dev   # Starts Jarvis
   ```

5. **Build Standalone**
   ```bash
   npm run electron:build
   ```

## 🎯 Labels
`AI Assistant` `Audio Visualizer` `Electron` `Three.js` `Gemini AI` `Productivity`

---
Developed with 💖 by **Ashutosh Kumar Singh**
