// Conversation Memory Management Module
class ConversationMemory {
    constructor() {
        this.storageKey = 'jarvis_conversation_history';
        this.maxHistoryLength = 50; // Maximum number of conversation turns to keep
        this.history = this.loadHistory();
    }

    // Load conversation history from localStorage
    loadHistory() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (error) {
            console.warn('Failed to load conversation history:', error);
        }
        return [];
    }

    // Save conversation history to localStorage
    saveHistory() {
        try {
            // Keep only the last maxHistoryLength entries
            if (this.history.length > this.maxHistoryLength) {
                this.history = this.history.slice(-this.maxHistoryLength);
            }
            localStorage.setItem(this.storageKey, JSON.stringify(this.history));
        } catch (error) {
            console.warn('Failed to save conversation history:', error);
        }
    }

    // Add a message to conversation history
    addMessage(role, content) {
        this.history.push({
            role: role, // 'user' or 'assistant'
            content: content,
            timestamp: new Date().toISOString()
        });
        this.saveHistory();
    }

    // Get conversation history formatted for API
    getContextMessages() {
        return this.history.map(msg => ({
            role: msg.role,
            content: msg.content
        }));
    }

    // Clear conversation history
    clearHistory() {
        this.history = [];
        this.saveHistory();
    }

    // Get conversation history for display
    getHistory() {
        return this.history;
    }

    // Export conversation history
    exportHistory(format = 'json') {
        if (format === 'json') {
            return JSON.stringify(this.history, null, 2);
        } else if (format === 'text') {
            return this.history.map(msg => 
                `${msg.role.toUpperCase()}: ${msg.content}\n[${new Date(msg.timestamp).toLocaleString()}]\n`
            ).join('\n');
        }
        return '';
    }
}

export default ConversationMemory;

