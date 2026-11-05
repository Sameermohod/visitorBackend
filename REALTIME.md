# Real-time features

Messages, notifications, SOS alerts and screens that refresh themselves when other people change something.

## What is live now

| Where | What happens |
|---|---|
| **Notification bell** | Every in-app notification (new charge, payment received, complaint assigned/escalated, camera access, notices, visitor at the gate…) is pushed the moment it is created. A short message appears on screen, and a desktop alert if the tab is in the background (opt-in from the bell). |
| **Messages** | One-to-one chats and a society-wide Community channel. Messages arrive instantly, with typing indicator, online dot, unread counts, "Seen", delete, and "show earlier messages". |
| **Visitor at the gate** | When a guard checks a visitor in, everyone living in that flat is alerted at once (email is still sent). |
| **Emergency SOS** | A resident, tenant or committee member taps **Emergency SOS**. Every guard, the Admin and the Secretary get a full-screen alarm with name, flat and note. When one taps "I'm on my way", the sender sees who is coming. |
| **Lists and dashboard** | Complaints, visitors, bills, maintenance charges, notices, residents, staff, tenancies, cameras and the dashboard reload by themselves when someone else changes that data. |

## Who can message whom

Decided on the server (`src/modules/messages/messages.rules.ts`), never by the screen.

| Sender | Can start a chat with |
|---|---|
| Society Admin, Secretary | Anyone in the society |
| Resident, Committee, Accountant, Supervisor | The office, each other, security guards |
| Security Guard | The office, residents and committee |
| Tenant | The office and their own landlord only |
| Repair staff (plumber, electrician…) | The office only |

- A flat owner and their current tenant can always write to each other.
- The people directory shows **name, role and flat only** (no email or phone). Residents are listed only when searched for.
- **Community channel**: Admin, Secretary, Committee, Residents, Accountant, Supervisor and Tenants. Not guards or repair staff. The office can remove any message there.
- **Private chats stay private**: the office cannot read or delete messages in chats they are not part of.
- **Moderation**: the Admin or Secretary can block a person from sending messages (Residents / Staff screens → *Block messages*). The office itself cannot be blocked.
- **Limits**: 2000 characters per message, 20 messages per person per minute.
- Someone with the app closed gets one bell notification (not one per message) while a conversation is unread.

## How it works

```
Browser ──WebSocket (Socket.IO, signed in with the same token as the API)──▶ Server
          ◀── "message:new", "notification", "sos", "data:changed" …
Browser ──REST (as before)──▶ Server     (sending a message, any change, any data)
```

- **Writes always use the normal REST API.** That keeps validation, permissions, rate limits and the audit trail in one place. The socket is for pushing things out, plus two tiny signals (typing, who is online).
- **Rooms are chosen by the server**, from the person's signed-in identity: their own, their society, their role in their society. The old code let a browser ask to join any room by id; that is removed.
- **"Something changed" carries no data**: only the area name (`complaints`, `billing`…). The screen then reloads through the normal API, so permissions are checked exactly as before. Your own changes are ignored (the screen already reloads itself).
- `notifyUsers()` (`src/services/payments.ts`) is the single place notifications are created; it now also pushes them.

### Events

`notification`, `data:changed {area, by}`, `message:new`, `message:deleted`, `message:read`, `message:seen`, `typing`, `sos`, `sos:response`, `sos:handled`. Client to server: `typing {conversationId}` and `presence {userIds}` (answers who is online).

## Why Socket.IO (research)

Sources we found (blog and guide level, not official documentation, so check the Socket.IO docs before relying on details) agree on this:

- **SSE** is one-way (server to browser) and simplest, which suits notifications only. **WebSockets** are two-way and suit chat (typing, online status).
- **Socket.IO** adds rooms and automatic reconnection on top of WebSockets. It was already installed in this project, so no new server dependency.
- **Scaling**: with more than one server copy, room broadcasts only reach clients connected to the same copy unless you add the **Redis adapter**. Sticky sessions matter mainly for Socket.IO's long-polling fallback.

Sources: [Valletta Software](https://vallettasoftware.com/ai-empowered-team-on-demand/how-to-set-up-websockets-in-nodejs), [ResumeLens](https://www.resumelens.org/blog/nodejs/nodejs-websockets-and-realtime), [Weam: Socket.IO at scale](https://opensource.weam.ai/?p=20376).

Competitors: we could not confirm from public pages whether MyGate or NoBrokerHood offer resident chat or instant visitor-approval alerts. Their marketing mentions visitor management, SOS and complaint alerts. Treat any comparison as unverified.

## Running more than one server copy

Everything above works on **one** server process (the current setup). Before running two or more copies:

1. Add the Socket.IO Redis adapter (`@socket.io/redis-adapter` + a Redis instance) in `src/realtime/hub.ts`.
2. Move the in-memory pieces to Redis too: online presence (`connections` in `hub.ts`), the SOS open-alert list (`safety.routes.ts`), the message rate limit (`messages.controller.ts`) and the response/user caches.

## Not built yet

- **Push when the app is closed.** Live updates need the app open in a tab. Notifications for a closed app need Web Push (service worker + VAPID keys) on Android/desktop, and are limited on iPhone unless the app is installed to the home screen. This is the most valuable next step for gate and SOS alerts.
- **Resident approve/deny for a visitor at the gate.** Check-in currently notifies; an approval step would be a new flow.
- **Attachments and photos in chat**, group chats other than the Community channel, message reporting.
- **Re-checking the login on a long-lived connection.** A socket is authenticated when it connects. If an account is deleted, its open connection stays until it reconnects.
- **Sound for chat messages** (only SOS has a sound).

## Testing

75 backend checks ran against real sockets and the real database (who can message whom, privacy of private chats, community rules, deletion rules, rate limits, blocking, offline notification throttling, presence, SOS delivery and response, "changed" signals carrying no data, sockets refused without a valid token). 21 browser checks drove two real Edge sessions (a resident and the admin) through live chat, "Seen", toasts, the bell, a self-refreshing notice list and the SOS alarm, with no browser console errors; the phone layout was checked at 390 px width. Not tested: real phones, Safari/iPhone, many simultaneous users, the closed-app case.
