// Screen Capture and OCR Module
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

    // Request OCR on screenshot
    async performOCR(imagePath) {
        if (window.electronAPI && window.electronAPI.performOCR) {
            return await window.electronAPI.performOCR(imagePath);
        }
        throw new Error('OCR not available');
    }

    // Capture and read screen
    async captureAndRead() {
        try {
            const screenshotPath = await this.captureScreen();
            if (screenshotPath) {
                const ocrText = await this.performOCR(screenshotPath);
                return ocrText;
            }
            return null;
        } catch (error) {
            console.error('Screen capture error:', error);
            throw error;
        }
    }
}

export default ScreenCapture;

