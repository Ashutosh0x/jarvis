// Screen Capture and OCR Module
// OCR is powered by Baidu Unlimited-OCR running on a local SGLang server
// (long-horizon document parsing — see docs/OCR-SETUP.md).
class ScreenCapture {
    constructor() {
        this.screenshotsPath = null;
    }

    // Request screenshot from Electron
    async captureScreen() {
        if (window.electronAPI && window.electronAPI.captureScreen) {
            return await window.electronAPI.captureScreen();
        }
        throw new Error('Screen capture not available');
    }

    // Check whether the local Unlimited-OCR server is reachable
    async isOcrAvailable() {
        if (window.electronAPI && window.electronAPI.checkOcrServer) {
            const status = await window.electronAPI.checkOcrServer();
            return status.available;
        }
        return false;
    }

    // OCR a local file (image or multi-page PDF) → structured Markdown
    async performOCR(filePath, mode = 'gundam') {
        if (window.electronAPI && window.electronAPI.performOCR) {
            return await window.electronAPI.performOCR({ filePath, mode });
        }
        throw new Error('OCR not available');
    }

    // Capture the screen and OCR it in "gundam" mode (dense single-page layouts)
    async captureAndRead() {
        try {
            const capture = await this.captureScreen();
            if (!capture || !capture.success) {
                throw new Error(capture?.error || 'Screen capture failed');
            }
            const result = await window.electronAPI.performOCR({
                imageBase64: capture.image,
                mode: 'gundam'
            });
            if (!result.success) throw new Error(result.error);
            return result.markdown;
        } catch (error) {
            console.error('Screen OCR error:', error);
            throw error;
        }
    }
}

export default ScreenCapture;
