# Jarvis Phone Bridge - Real-Time Phone Notifications over Wi-Fi

Jarvis announces phone notifications the moment they arrive:
"Sir, you have a new message from Priya on WhatsApp."

Architecture follows the cross-device pattern validated in current research
(DevicesWorld, arXiv:2607.13465; WISPA, arXiv:2606.23255): the phone is a
lightweight event source pushing over the LAN, the desktop does all reasoning.
Event-driven push, not polling — near-zero battery cost, sub-second latency.

No custom Android app is required.

## How it works

```
Android notification
        |
MacroDroid (free app, "Notification Received" trigger)
        |
HTTP POST over Wi-Fi (token-authenticated)
        |
Jarvis listener  http://<pc-ip>:8765/notify
        |
Spoken announcement + on-screen preview + stored in long-term memory
```

Every relayed notification is also ingested into Jarvis's RAG memory, so you
can later ask: "What messages did I get this afternoon?"

## Setup (about 5 minutes)

1. Say **"Jarvis, phone setup"** (or type `phone bridge`). Jarvis displays
   your PC's URL and secret token, e.g.
   `http://192.168.1.4:8765/notify?token=a1b2c3...`

2. On the phone, install **MacroDroid** (Play Store, free tier is enough).

3. Create a macro:
   - **Trigger**: Notification -> Notification Received -> Any Application
     (or select only the apps you care about - recommended: messaging apps)
   - **Action**: HTTP Request
     - Method: POST
     - URL: the URL Jarvis displayed
     - Content type: `application/json`
     - Body (use the Magic Text picker `...` to insert the notification
       variables shown in brackets):
       ```json
       {"app":"[Notification app name]","title":"[Notification title]","text":"[Notification text]"}
       ```

4. First run: Windows will ask to allow Jarvis (Electron/Node) through the
   firewall - allow it on **Private networks**.

5. Test: send yourself a message. Jarvis should announce it within a second.

## Security notes

- The listener binds to your LAN only and requires the secret token
  (stored in `%APPDATA%/jarvis/phone-bridge.json`; delete the file to
  rotate the token on next launch).
- Requests without the token get 401. Payloads are size-capped.
- Nothing leaves your network: phone -> PC directly over Wi-Fi.
- Duplicate notifications (Android re-posts on updates) are deduped for 15s.

## Realistic scope (what this deliberately does NOT do)

Full two-way phone *control* (sending replies, tapping UI) is where even
frontier agents score only ~12.5% on the DevicesWorld benchmark - not
reliable enough to ship. This bridge does the high-value, fully-reliable
half: real-time awareness. Reply-from-desktop can be added later via
MacroDroid webhook triggers if wanted.
