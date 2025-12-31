# JARVIS - Neural Assistant and Audio Visualizer

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=three.js&logoColor=white" />
  <img src="https://img.shields.io/badge/Google%20Gemini-8E75C2?style=for-the-badge&logo=googlegemini&logoColor=white" />
</p>

JARVIS is a professional-grade, GPU-accelerated desktop assistant and 3D audio visualizer. It integrates high-speed AI grounding with a translucent user interface to provide a seamless bridge between human interaction and computer control.


https://github.com/user-attachments/assets/d450733c-f145-4122-a327-05e669a18c1a




## Project Vision

JARVIS is designed to act as a central nervous system for your desktop environment, leveraging the Gemini 2.0 Flash Live API for real-time multi-modal communication. It combines specialized system-level tools with web-grounded intelligence to handle everything from file management to complex research queries instantly.

## Comprehensive Feature Set

### 1. Advanced 3D Visualizer
- GPU-Accelerated Rendering: Utilizes Three.js for butter-smooth visual performance at 60+ FPS.
- Floating Orb Aesthetics: A frameless, transparent UI that hovers non-intrusively over any open application.
- Real-Time Audio Reactivity: The visualizer sphere pulses and transforms dynamically based on your voice or Jarvis's responses.
- Ambient Color Cycling: Features smooth HSL color transitions during idle states to maintain an active visual presence.

### 2. Grounded Intelligence and Search
- Instant Web Grounding: Uses native Google Search retrieval to provide factual, up-to-date information without the latency of traditional web scraping.
- Grounded Intel HUD: A dedicated side-panel manifests to display source links and citations for all web-retrieved facts.
- Proactive Verification: The AI is configured to verify real-world data proactively, ensuring maximum accuracy for research and news inquiries.

### 3. Neural Synthesis and Vision
- Image Generation: Create high-fidelity illustrations directly through voice commands via the integrated image generation tool.
- Visual Cortex: Jarvis can "see" through your camera feed, allowing for features like "Reimagine User" where it transforms the live feed into artistic portraits.
- Sidebar Preview: All generated media is displayed in a persistent, non-intrusive container on the right side of the screen.

### 4. System and Productivity Control
- Application Management: Launch any installed Windows application (Chrome, VS Code, Explorer, etc.) through voice or text.
- File Operations: Robust handling for folder creation, file deletion, and directory listing across your system.
- Window Control: Minimize, maximize, or close windows using neural commands.
- Clipboard Integration: Read from or write to the system clipboard instantly.
- OS Hardware Control: Voice-activated control over volume, brightness, and system power states (Shutdown/Restart).

### 5. Calendar and Reminders
- Natural Language Scheduling: Set reminders and add events using natural phrasing (e.g., "Remind me to call John in 10 minutes").
- Schedule Management: Retrieve your today's agenda verbally.

## Technology Stack

- Core Framework: [Electron](https://www.electronjs.org/) for native OS integration and transparency.
- Build Tool: [Vite](https://vitejs.dev/) for high-speed frontend development and HMR.
- AI Logic: [Google Generative AI SDK](https://ai.google.dev/) (Gemini 2.0 Flash Live).
- 3D Engine: [Three.js](https://threejs.org/) for WebGL-based visuals.
- Audio Processing: Web Audio API with custom AudioWorklets for low-latency streaming.

## Installation and Setup

### Prerequisites
- Node.js (Version 18 or higher).
- A valid Gemini API Key.

### Development Setup
1. Clone the repository to your local machine.
2. Install dependencies using npm install.
3. Configure your API credentials in src/config.js (Refer to src/config.example.js).
4. Run npm run dev to start the local Vite server.
5. Run npm run electron:dev to launch the Jarvis application in development mode.

### Production Build
1. Run npm run electron:build to generate the standalone Windows installer.
2. The executable will be located in the release folder.

## Distribution and Licensing
This project is licensed under the ISC License. Contributions are welcome to enhance the neural link and visual capabilities of Jarvis.

Developed by Ashutosh Kumar Singh (Ashutosh0x)

