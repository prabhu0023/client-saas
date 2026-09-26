# DoctorDesk — Screenshot & Mockup Specifications

> Detailed descriptions for creating screenshots, mockups, and screen recordings for the pitch deck and video.

---

## 📱 WHATSAPP CONVERSATION MOCKUPS

### Mockup 1: Complete Booking Flow

**Purpose:** Show the entire patient journey from "I need an appointment" to confirmation.

**Device:** iPhone or Android phone mockup (WhatsApp interface)

**Chat Header:**
- Profile picture: Green circle with "SW" or a medical cross icon
- Name: "HealthFirst Clinic" (or your demo clinic name)
- Status: "online" or "typing..."

**Conversation Thread:**

```
[Patient - outgoing, green bubble]
I need an appointment
[timestamp: 10:23 AM ✓✓]

[Clinic - incoming, dark bubble]
Welcome to HealthFirst Clinic! 👋

Please select a doctor:

1. Dr. Arun Sharma (General Medicine)
2. Dr. Priya Patel (Cardiology)
3. Dr. Vikram Gupta (Pediatrics)

Reply with the number of your choice.
[timestamp: 10:23 AM]

[Patient - outgoing]
1
[timestamp: 10:23 AM ✓✓]

[Clinic - incoming]
Dr. Arun Sharma — Available days:

1. Thu, Oct 3 (4 slots available)
2. Fri, Oct 4 (7 slots available)
3. Mon, Oct 7 (5 slots available)
4. Tue, Oct 8 (3 slots available)

Reply with the number.
[timestamp: 10:23 AM]

[Patient - outgoing]
2
[timestamp: 10:24 AM ✓✓]

[Clinic - incoming]
Friday, Oct 4 — Available times:

1. 09:00 AM
2. 09:30 AM
3. 10:30 AM
4. 11:00 AM
5. 02:00 PM
6. 02:30 PM
7. 03:00 PM

Reply with the number.
[timestamp: 10:24 AM]

[Patient - outgoing]
3
[timestamp: 10:24 AM ✓✓]

[Clinic - incoming]
✅ Appointment Confirmed!

Dr. Arun Sharma
📅 Friday, October 4, 2026
🕥 10:30 AM
📍 HealthFirst Clinic, MG Road

We'll send you a reminder before your appointment.

To cancel or reschedule, type "cancel" or "reschedule".
[timestamp: 10:24 AM]
```

**Visual Notes:**
- Use authentic WhatsApp colors (dark mode preferred for modern look)
- Green checkmarks on patient messages (✓✓ = delivered/read)
- Proper bubble shapes with tails
- Show keyboard at bottom (optional)

---

### Mockup 2: Slot-Taken Recovery

**Purpose:** Demonstrate the zero-double-booking guarantee

**Scenario:** Two patients try to book the same slot simultaneously

**Phone A (left side):**
```
[Patient A - outgoing]
3
[timestamp: 10:24 AM ✓✓]

[Clinic - incoming]
✅ Appointment Confirmed!

Dr. Arun Sharma
📅 Friday, October 4, 2026
🕥 10:30 AM

[timestamp: 10:24 AM]
```

**Phone B (right side):**
```
[Patient B - outgoing]
3
[timestamp: 10:24 AM ✓✓]

[Clinic - incoming]
That slot was just taken! Here are the remaining times for Friday, Oct 4:

1. 09:00 AM
2. 09:30 AM
3. 11:00 AM ← next available
4. 02:00 PM

Reply with the number.
[timestamp: 10:24 AM]
```

**Visual Notes:**
- Side-by-side phone mockups
- Same timestamp on both to emphasize simultaneity
- Highlight "just taken" message

---

### Mockup 3: Appointment Reminder

**Purpose:** Show the automatic reminder feature

```
[Clinic - incoming, with template header]
📋 APPOINTMENT REMINDER

Hi Priya! 👋

This is a reminder for your upcoming appointment:

👨‍⚕️ Dr. Arun Sharma
📅 Tomorrow (Friday, Oct 4)
🕥 10:30 AM
📍 HealthFirst Clinic, MG Road

Please arrive 10 minutes early.

To reschedule, type "reschedule".
To cancel, type "cancel".

[timestamp: 6:00 PM, Oct 3]
```

---

### Mockup 4: Patient Cancel Flow

**Purpose:** Show self-service cancellation

```
[Patient - outgoing]
cancel
[timestamp: 3:45 PM ✓✓]

[Clinic - incoming]
Your upcoming appointments:

1. Dr. Sharma — Fri, Oct 4, 10:30 AM
2. Dr. Patel — Mon, Oct 14, 2:00 PM

Which appointment would you like to cancel? Reply with the number, or type "back" to return.
[timestamp: 3:45 PM]

[Patient - outgoing]
1
[timestamp: 3:45 PM ✓✓]

[Clinic - incoming]
✅ Appointment Cancelled

Your appointment with Dr. Sharma on Friday, Oct 4 at 10:30 AM has been cancelled.

To book a new appointment, type "book".
[timestamp: 3:45 PM]
```

---

## 💻 STAFF PORTAL MOCKUPS

### Mockup 5: Dashboard — Day View

**Purpose:** Main staff interface showing today's appointments

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│ [Logo: DoctorDesk]                     [Dashboard] [Availability] [Settings] │
│                                                        Dr. Sharma ▼ │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Today's Appointments                    ◀ Oct 3  │ Oct 4 │ Oct 5 ▶ │
│  Friday, October 4, 2026 • 8 appointments                       │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 09:00   │ Priya Mehta          │ General    │ [Confirmed] │  │
│  │ AM      │ +91 98765 43210      │ Checkup    │             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 09:30   │ Rahul Verma          │ Follow-up  │ [Booked]    │  │
│  │ AM      │ +91 87654 32109      │            │             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 10:30   │ Anita Singh          │ Consult    │ [Booked]    │  │
│  │ AM      │ +91 76543 21098      │            │             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 11:00   │ Vikram Reddy         │ General    │ [Completed] │  │
│  │ AM      │ +91 65432 10987      │ Checkup    │             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Status Badge Colors:**
- **Booked:** Blue (#5dade2 on dark blue bg)
- **Confirmed:** Green (#58d68d on dark green bg)
- **Completed:** Gray (#aaa on dark gray bg)
- **Cancelled:** Red (#e74c3c on dark red bg)
- **No-Show:** Orange (#f39c12 on dark orange bg)

**Interaction States:**
- Hover on appointment row: subtle highlight
- Click on appointment: expand to show action buttons (Confirm, Cancel, Complete, No-Show)

---

### Mockup 6: Dashboard — Week View

**Purpose:** Show weekly overview with appointment counts

```
┌─────────────────────────────────────────────────────────────────┐
│  Week of October 1-7, 2026                                      │
│                                                                 │
│  ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┐    │
│  │  Mon  │  Tue  │  Wed  │  Thu  │  Fri  │  Sat  │  Sun  │    │
│  │  Oct 1│  Oct 2│  Oct 3│  Oct 4│  Oct 5│  Oct 6│  Oct 7│    │
│  ├───────┼───────┼───────┼───────┼───────┼───────┼───────┤    │
│  │       │       │       │       │       │       │       │    │
│  │   5   │   7   │   4   │   8   │   6   │  OFF  │  OFF  │    │
│  │ appts │ appts │ appts │ appts │ appts │       │       │    │
│  │       │       │       │       │       │       │       │    │
│  └───────┴───────┴───────┴───────┴───────┴───────┴───────┘    │
│                                                                 │
│  Click any day to view appointments                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Mockup 7: Availability Management

**Purpose:** Show how staff configure doctor schedules

```
┌─────────────────────────────────────────────────────────────────┐
│ [Logo: DoctorDesk]                     [Dashboard] [Availability] [Settings] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Availability Settings                   Dr. Arun Sharma ▼      │
│                                                                 │
│  Weekly Schedule                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Monday      │ 09:00 AM - 01:00 PM │ 02:00 PM - 06:00 PM │  │
│  │ Tuesday     │ 09:00 AM - 01:00 PM │ 02:00 PM - 06:00 PM │  │
│  │ Wednesday   │ 09:00 AM - 01:00 PM │ — (afternoon off)    │  │
│  │ Thursday    │ 09:00 AM - 01:00 PM │ 02:00 PM - 06:00 PM │  │
│  │ Friday      │ 09:00 AM - 01:00 PM │ 02:00 PM - 05:00 PM │  │
│  │ Saturday    │ — (day off)         │                      │  │
│  │ Sunday      │ — (day off)         │                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Slot Duration: [15 min ▼]                                      │
│                                                                 │
│  Exceptions (Upcoming)                            [+ Add Exception] │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Oct 15, 2026   │ Day Off    │ Diwali                 [✕] │  │
│  │ Oct 25, 2026   │ Extra Hours│ 06:00 PM - 08:00 PM    [✕] │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│                                          [Save Changes]          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Mockup 8: Appointment Action Modal

**Purpose:** Show the status change interface

```
┌─────────────────────────────────────────────┐
│              Appointment Details             │
│─────────────────────────────────────────────│
│                                              │
│  Patient: Priya Mehta                        │
│  Phone: +91 98765 43210                      │
│  Service: General Checkup                    │
│                                              │
│  Date: Friday, October 4, 2026               │
│  Time: 10:30 AM                              │
│  Status: Booked                              │
│                                              │
│  Booked via: WhatsApp                        │
│  Booked on: Oct 2, 2026, 10:24 AM            │
│                                              │
│─────────────────────────────────────────────│
│                                              │
│  [Confirm ✓]  [Cancel ✕]  [No-Show ○]        │
│                                              │
│  ⚠️ Cancelling will notify the patient       │
│     via WhatsApp automatically.              │
│                                              │
└─────────────────────────────────────────────┘
```

---

## 📊 INFOGRAPHIC MOCKUPS

### Mockup 9: Problem-Solution Comparison

**Purpose:** Visual before/after comparison

**Left Side (The Old Way):**
```
❌ Patient calls clinic
   ↓
❌ Line is busy / no answer
   ↓
❌ Tries again later
   ↓
❌ Finally gets through
   ↓
❌ Receptionist checks paper schedule
   ↓
❌ "Can you hold?" (checks with doctor)
   ↓
❌ Appointment noted on paper
   ↓
❌ Phone reminder the night before
   ↓
❌ Patient doesn't answer
   ↓
❌ No-show

Total time: 15-30 minutes
Failure rate: High
```

**Right Side (DoctorDesk):**
```
✅ Patient texts WhatsApp
   ↓
✅ Instant response (24/7)
   ↓
✅ Picks doctor
   ↓
✅ Sees real-time availability
   ↓
✅ Picks time
   ↓
✅ Confirmed instantly
   ↓
✅ WhatsApp reminder (98% open rate)
   ↓
✅ Patient arrives on time

Total time: <60 seconds
Failure rate: Near zero
```

---

### Mockup 10: Architecture Diagram (Simplified)

**Purpose:** For technically curious doctors / clinic admins

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Patient                                                   │
│   (WhatsApp)                                                │
│       │                                                     │
│       ▼                                                     │
│   ┌───────────┐                                             │
│   │ WhatsApp  │                                             │
│   │ Business  │                                             │
│   │ API       │                                             │
│   └─────┬─────┘                                             │
│         │                                                   │
│         ▼                                                   │
│   ┌───────────────────────────────────────────────────┐    │
│   │                 DoctorDesk                        │    │
│   │  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │    │
│   │  │ Booking  │  │ Slot     │  │ Notification │    │    │
│   │  │ Engine   │  │ Generator│  │ Engine       │    │    │
│   │  └────┬─────┘  └────┬─────┘  └──────┬───────┘    │    │
│   │       │             │               │            │    │
│   │       └─────────────┼───────────────┘            │    │
│   │                     │                            │    │
│   │                     ▼                            │    │
│   │            ┌──────────────┐                      │    │
│   │            │   Database   │                      │    │
│   │            │  (Postgres)  │                      │    │
│   │            │              │                      │    │
│   │            │ 🔒 No double │                      │    │
│   │            │   booking    │                      │    │
│   │            │  constraint  │                      │    │
│   │            └──────────────┘                      │    │
│   └───────────────────────────────────────────────────┘    │
│         │                                                   │
│         ▼                                                   │
│   ┌───────────┐                                             │
│   │ Staff     │                                             │
│   │ Portal    │                                             │
│   │ (Web)     │                                             │
│   └───────────┘                                             │
│       │                                                     │
│       ▼                                                     │
│   Staff                                                     │
│   (Browser)                                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🎬 SCREEN RECORDING SEQUENCES

### Recording 1: Full Booking Demo (60 seconds)

**Setup:**
- Phone with WhatsApp open
- Laptop with portal dashboard visible (split screen or picture-in-picture)

**Script:**
1. **0:00-0:05** — Show empty chat, type "I need an appointment"
2. **0:05-0:10** — Wait for doctor list, tap "1"
3. **0:10-0:15** — Wait for day list, tap "2" (Friday)
4. **0:15-0:20** — Wait for time list, tap "3" (10:30 AM)
5. **0:20-0:25** — Show confirmation message
6. **0:25-0:35** — Cut to laptop: refresh dashboard, show new appointment appearing
7. **0:35-0:45** — Click on appointment, show the details
8. **0:45-0:55** — Click "Confirm", show status change
9. **0:55-0:60** — Show patient receiving confirmation notification

---

### Recording 2: Double-Booking Prevention Demo (30 seconds)

**Setup:**
- Two phones side by side
- Both at the "pick a time" step for the same doctor/day

**Script:**
1. **0:00-0:05** — Show both phones with same time options
2. **0:05-0:10** — Tap "3" (10:30 AM) on BOTH phones simultaneously
3. **0:10-0:20** — Phone A: shows confirmation. Phone B: shows "slot just taken" message
4. **0:20-0:30** — Zoom on Phone B showing alternative times

---

### Recording 3: Availability Management (45 seconds)

**Setup:**
- Portal open to Availability page

**Script:**
1. **0:00-0:10** — Show existing weekly schedule
2. **0:10-0:20** — Click "Add Exception", add a day off (e.g., Oct 15 - Diwali)
3. **0:20-0:30** — Save changes
4. **0:30-0:45** — Switch to WhatsApp, try to book for Oct 15, show it's not available

---

## 🎨 DESIGN SPECIFICATIONS

### Color Palette

| Use | Color | Hex |
|-----|-------|-----|
| Primary (WhatsApp green) | Green | #25D366 |
| Primary dark | Teal | #128C7E |
| Background (dark mode) | Near black | #0a0a0a |
| Card background | Dark gray | #1a1a1a |
| Text primary | White | #ffffff |
| Text secondary | Gray | #888888 |
| Error/Cancel | Red | #e74c3c |
| Warning | Orange | #f39c12 |
| Success | Green | #58d68d |
| Info/Booked | Blue | #5dade2 |

### Typography

| Element | Font | Size | Weight |
|---------|------|------|--------|
| Slide titles | System sans-serif | 48-56px | 700 |
| Section labels | System sans-serif | 12px | 400, uppercase |
| Body text | System sans-serif | 16-18px | 400 |
| WhatsApp messages | System sans-serif | 14px | 400 |
| Stats numbers | System sans-serif | 64px | 800 |

### Spacing

- Slide padding: 60-80px
- Card padding: 25-30px
- Card border-radius: 12-16px
- Grid gaps: 25-30px

---

## 📦 DELIVERABLES CHECKLIST

### Screenshots to Capture

- [ ] WhatsApp: Full booking conversation (scrollable)
- [ ] WhatsApp: Slot-taken recovery message
- [ ] WhatsApp: Appointment reminder
- [ ] WhatsApp: Cancel flow
- [ ] WhatsApp: Reschedule flow
- [ ] Portal: Dashboard day view (with varied statuses)
- [ ] Portal: Dashboard week view
- [ ] Portal: Availability management
- [ ] Portal: Appointment detail modal

### Screen Recordings to Make

- [ ] Complete booking flow (phone + portal split)
- [ ] Double-booking prevention (two phones)
- [ ] Staff changing appointment status
- [ ] Availability configuration

### Graphics to Create

- [ ] Logo (if not already done)
- [ ] Problem vs. Solution comparison infographic
- [ ] Simplified architecture diagram
- [ ] Roadmap timeline visual
- [ ] Stats infographic (500M+, 98%, <60s)
