// Calendar and Reminder System
class CalendarSystem {
    constructor() {
        this.storageKey = 'jarvis_calendar_events';
        this.remindersKey = 'jarvis_reminders';
        this.events = this.loadEvents();
        this.reminders = this.loadReminders();
        this.reminderCheckInterval = null;
        this.startReminderChecker();
    }

    // Load events from localStorage
    loadEvents() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.warn('Failed to load events:', error);
            return [];
        }
    }

    // Save events to localStorage
    saveEvents() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.events));
        } catch (error) {
            console.warn('Failed to save events:', error);
        }
    }

    // Load reminders from localStorage
    loadReminders() {
        try {
            const stored = localStorage.getItem(this.remindersKey);
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.warn('Failed to load reminders:', error);
            return [];
        }
    }

    // Save reminders to localStorage
    saveReminders() {
        try {
            localStorage.setItem(this.remindersKey, JSON.stringify(this.reminders));
        } catch (error) {
            console.warn('Failed to save reminders:', error);
        }
    }

    // Add an event
    addEvent(title, date, time) {
        const event = {
            id: Date.now().toString(),
            title,
            date,
            time,
            createdAt: new Date().toISOString()
        };
        this.events.push(event);
        this.saveEvents();
        return event;
    }

    // Add a reminder
    addReminder(text, date, time) {
        const reminder = {
            id: Date.now().toString(),
            text,
            date,
            time,
            notified: false,
            createdAt: new Date().toISOString()
        };
        this.reminders.push(reminder);
        this.saveReminders();
        return reminder;
    }

    // Get events for a specific date
    getEventsForDate(date) {
        const targetDate = new Date(date).toDateString();
        return this.events.filter(event => {
            const eventDate = new Date(event.date).toDateString();
            return eventDate === targetDate;
        });
    }

    // Get today's events
    getTodayEvents() {
        return this.getEventsForDate(new Date());
    }

    // Parse date and time from natural language
    parseDateTime(text) {
        const now = new Date();
        let date = new Date(now);
        let time = '12:00';

        // Parse time (e.g., "at 3 PM", "at 15:30")
        const timeMatch = text.match(/at\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/i);
        if (timeMatch) {
            time = this.parseTime(timeMatch[1]);
        }

        // Parse date (e.g., "tomorrow", "next Monday", "in 2 hours")
        if (text.includes('tomorrow')) {
            date.setDate(date.getDate() + 1);
        } else if (text.includes('today')) {
            // Already set to today
        } else if (text.includes('in') && text.includes('hour')) {
            const hourMatch = text.match(/in\s+(\d+)\s+hour/i);
            if (hourMatch) {
                date.setHours(date.getHours() + parseInt(hourMatch[1]));
            }
        } else if (text.includes('in') && text.match(/in\s+(\d+)\s+minute/i)) {
            const minuteMatch = text.match(/in\s+(\d+)\s+minute/i);
            if (minuteMatch) {
                date.setMinutes(date.getMinutes() + parseInt(minuteMatch[1]));
            }
        }

        return {
            date: date.toISOString().split('T')[0],
            time: time
        };
    }

    // Parse time string
    parseTime(timeStr) {
        timeStr = timeStr.trim().toUpperCase();
        
        // Handle 12-hour format
        if (timeStr.includes('AM') || timeStr.includes('PM')) {
            const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/);
            if (match) {
                let hours = parseInt(match[1]);
                const minutes = match[2] ? parseInt(match[2]) : 0;
                const period = match[3];

                if (period === 'PM' && hours !== 12) hours += 12;
                if (period === 'AM' && hours === 12) hours = 0;

                return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
            }
        }
        
        // Handle 24-hour format
        const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?/);
        if (match) {
            const hours = parseInt(match[1]).toString().padStart(2, '0');
            const minutes = (match[2] ? parseInt(match[2]) : 0).toString().padStart(2, '0');
            return `${hours}:${minutes}`;
        }

        return '12:00';
    }

    // Check for due reminders
    checkReminders() {
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        const currentDate = now.toISOString().split('T')[0];

        this.reminders.forEach(reminder => {
            if (!reminder.notified && 
                reminder.date === currentDate && 
                reminder.time <= currentTime) {
                this.triggerReminder(reminder);
                reminder.notified = true;
                this.saveReminders();
            }
        });
    }

    // Trigger a reminder notification
    triggerReminder(reminder) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Jarvis Reminder', {
                body: reminder.text,
                icon: null
            });
        }
    }

    // Start reminder checker
    startReminderChecker() {
        // Check every minute
        this.reminderCheckInterval = setInterval(() => {
            this.checkReminders();
        }, 60000);
    }

    // Request notification permission
    async requestNotificationPermission() {
        if ('Notification' in window) {
            if (Notification.permission === 'default') {
                await Notification.requestPermission();
            }
        }
    }
}

export default CalendarSystem;

