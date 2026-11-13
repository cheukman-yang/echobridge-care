# EchoBridge Care

[English](README.md) | [日本語](README.ja.md)

**End-to-End Medical Accessibility & Bilingual Healthcare Dialogue Assistant**

![Next.js](https://img.shields.io/badge/Next.js-16.4.5-black?logo=next.js)
![React](https://img.shields.io/badge/React-19.3-149eca?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript)
![Tests](https://img.shields.io/badge/Tests-27%20files%20%7C%20745%20passing-0d9488)
![License](https://img.shields.io/badge/License-MIT-slate)

---

## 1. Overview

**EchoBridge Care** is an end-to-end medical accessibility and bilingual communication web application designed for patients with speech or hearing difficulties (such as dysarthria, stuttering, laryngectomy, or hearing loss) as well as international patients navigating language barriers in clinical settings.

Traditional assistive or translation tools only address isolated moments, leaving patients stranded during phone bookings or awkward across-the-desk consultations. EchoBridge Care connects the entire patient journey seamlessly on a single smartphone or PC browser:

1. **Clinic Triage & AI Booking Phone Call (`/`)**: Organize symptoms, find suitable departments/clinics, and complete a booking call using synthesized voice, AI-generated 3-choice replies, and saved quick phrases.
2. **Directions & Clinic Arrival**: Navigate to the clinic via consistent Google Maps Directions & Area Map links and carry saved booking details straight into the exam room.
3. **Flat-Screen 180° Face-to-Face Consultation (`/consult`)**: Place the device flat on the examination desk with a 180°-rotated Doctor view on top and an upright Patient view on the bottom—featuring asymmetric microphone controls and real-time Japanese/English clinical translation.
4. **Structured Clinical Summary & Follow-Up Scheduling**: Review structured bullet-point summaries of findings, prescriptions, and care instructions, and add evidence-based follow-up visits to Google Calendar in one tap.

Every screen supports instant **English / Japanese (`🇺🇸 English` / `🇯🇵 日本語`)** UI switching, interactive **visual action cues** (shimmer highlight and subtle micro-vibration on the next recommended button), and a **zero-configuration Local Demo Mode** that works out of the box without API keys.

---

## 2. Key Features & Asymmetric UX Design

### 🏥 4-Step AI Simulated Clinic Booking (`/` — Booking Wizard)
- **Step 1 — Symptom, Area & Origin Input**:
  - Enter chief complaints, preferred clinical department, target area, origin station/address for directions, and top-3 preferred appointment windows.
  - Includes **`Fill Example`** (auto-populates symptoms, area `Around Shinjuku Station`, and origin `Shinjuku Station` so Maps directions work even without GPS) and **`✨ AI Polish`** (refines rough notes into clear, polite clinical phrasing directly inside the editable field).
- **Step 2 — AI Department Triage & Mock Clinic Selection**:
  - Summarizes symptoms, recommends relevant clinical departments, and pins **`[For Review/Testing] EchoBridge Care Mock Clinic`** at the top so judges can test the entire call safely inside the browser without placing real PSTN phone calls.
- **Step 3 — Opening Message & Default-Preset Saved Phrases**:
  - Auto-composes the opening phone greeting from Steps 1–2 and lets users select synthesized voice gender.
  - Pre-loads **1 default accessibility phrase** (*"I use AI voice and text support to communicate. Please speak slowly and clearly."*) on initial access, features a prominent **`[✅ Confirm & Save Phrase to List]`** button, and automatically commits any unconfirmed draft when starting the call.
- **Step 4 — Real-Time AI Receptionist Call & 2-Page Completion**:
  - Conducts a synthesized Japanese TTS call with English translation subtitles, a collapsible **AI 3-Choice Replies** drawer, a horizontally swipeable **Quick Phrases** rail (with right-edge fade & swipe cue) separated from **`📌 Saved Phrases (N)`**, and a **2-row wide input bar** (`w-full` text input on Row 1 + `[🎤 Voice | ✨ AI Polish | 📤 Send]` on Row 2).
  - **Completion Page 1 (Clinic Directions)**: Saves the appointment locally and generates aligned **Google Maps Directions** and **Area Map** links using normalized real-world station/street landmarks.
  - **Completion Page 2 (Calendar & Handoff)**: Provides 1-tap **Google Calendar** registration, a collapsible call transcript, and a **`🩺 Arrived at the Clinic: Open Face-to-Face Mode`** handoff button.

### 🩺 Flat-Screen 180° Face-to-Face Consultation (`/consult`)
- **Compact 2-Step Pre-Consultation Setup**:
  - **Prep Step 1**: Select one of three clinical dialogue pairs (`🇯🇵 JA ⇄ JA`, `🌐 EN Patient ⇄ JA Doctor`, or `✈️ JA Patient ⇄ EN Doctor` for overseas travel) and import a saved booking record in one tap.
  - **Prep Step 2**: Polish symptom/allergy notes (`✨ AI Polish`) and verify saved quick phrases before entering the exam room.
- **Asymmetric Doctor / Patient Split-Screen UX**:
  - **Doctor Side (Top 1/3, rotated `180°` for across-the-desk readability)**:
    - Displays the patient's confirmed message in large, high-contrast typography in the doctor's language with 1-tap TTS replay.
    - Uses a **Push-to-Talk (`Hold to Speak`)** microphone button so ambient clinic noise or computer typing is never recorded accidentally, paired with a **`🤖 Next Question (Demo)`** button in the center bar for 1-device judge walkthroughs.
  - **Patient Side (Bottom 2/3, upright)**:
    - Features a wide **LINE/WhatsApp-style bilingual chat timeline** (doctor turns on the left with original + translated text; patient turns on the right) with auto-scroll.
    - Combines a collapsible **AI 3-Choice Replies** drawer, swipeable **Quick Phrases** + **`📌 Saved Phrases`** toggle, and a **2-row wide input bar**: full-width text field on top, and **toggle-style `🎤 Voice`** + in-place editable **`✨ AI Polish`** + explicit **`📤 Show to Doctor`** confirmation below.

### 📋 Structured Clinical Summary & Evidence-Based Follow-Up Calendar
- **Structured Medical Summary**: Distills the consultation into three clinical sections—**(1) Chief Complaint**, **(2) Exam Findings & Allergies/History** (filtering out raw doctor questions), and **(3) Prescriptions, Care Instructions & Next Visit**—displayed bilingually.
- **Strict Evidence-Based Follow-Up Extraction**: Extracts follow-up dates and times strictly from spoken dialogue—never fabricating clock times (generating an **All-Day Event** when no specific hour was mentioned, or exact start/end times when stated) and embedding both the clinic name and editable street address into the **Google Calendar** `location` parameter.
- **Home Hub History (`📋 Past Bookings & Consultations`)**: Displays compact booking/consultation counts and latest visit previews on `/`, expanding to full local history cards with 1-tap **Re-book** and **Face-to-Face Consult** handoffs.

### 🔒 Privacy-First Local Storage & Zero-Config Local Demo Mode
- **Browser-Only Medical Persistence**: Sensitive symptom memos, call transcripts, saved quick phrases, booking records, and consultation summaries are stored **exclusively in browser `localStorage`**—never persisted to an external database.
- **4-Second Timeout & Instant Local Demo Fallback**: Every AI endpoint enforces a strict **4-second timeout** and automatically switches to a deterministic clinical response engine when Gemini credentials are absent or unreachable. Header badges (`Gemini Live AI` vs. `Local Demo Mode`) transparently indicate the active engine at all times.
- **Two-Browser Live Web Call (`/join`)**: Also preserves browser-to-browser WebSocket live relay rooms (`/join`) for real-time two-device human communication.

---

## 3. Quick Start & 2-Minute Judge Walkthrough

### Quick Start (No `.env` or API Keys Required)

```bash
# 1. Install dependencies
npm install

# 2. Launch the development server (runs immediately in Local Demo Mode if no API key is configured)
npm run dev
```

Open **`http://localhost:3000`** in Chrome, Edge, or Safari.  
*(No `.env.local` file, cloud credentials, database, or login is required to evaluate every workflow end-to-end.)*

---

### ⏱️ 2-Minute End-to-End Judge Walkthrough

Follow the **glowing teal action buttons (shimmer + subtle micro-vibration)** on each screen—they guide you through the primary path in under 2 minutes on a single device:

#### Part 1: AI Clinic Booking Call & Directions (`/` — ~60 seconds)
1. **Home Hub (`/`)**: Choose **`🇺🇸 English`** (or `🇯🇵 日本語`) in the top bar, then tap **`🏥 Find a Clinic & Book by AI Phone`**.
2. **Step 1/4**: Tap **`Fill Example`** to populate symptoms, department, preferred area (`Around Shinjuku Station`), and origin (`Shinjuku Station`). *(Optional: tap **`✨ AI Polish`** to test editable clinical phrasing refinement.)* Tap **`Next: Search Clinics`**.
3. **Step 2/4**: On the pinned top card (`[For Review/Testing] EchoBridge Care Mock Clinic`), tap **`Select This Mock Clinic & Prepare Call`**.
4. **Step 3/4**: Confirm the auto-generated opening message (note the pre-seeded default phrase in *Saved Quick Phrases*) and tap **`Start AI Booking Call`**.
5. **Step 4/4 (In-Browser AI Call)**:
   - Read/listen to the AI receptionist's greeting and proposed appointment time.
   - Tap **`💡 Open AI 3-Choice Replies ▲`** to send a 1-tap reply, or test **`📌 Saved Phrases (1)`**, the swipeable **Quick Phrases** rail, or the **2-row wide input bar** (`🎤 Voice` / `✨ AI Polish` / `📤 Send`).
   - Tap **`End Call & View Appointment / Directions`** (or `End Call & Review` in the header).
6. **Completion Pages 1 ➔ 2**:
   - **Page 1**: Check **`Open Directions in Google Maps`** (origin set to `Shinjuku Station`) and **`View Area Map`**, then tap **`[Next: Proceed to Google Calendar Registration →]`**.
   - **Page 2**: Inspect the **Google Calendar** preview and collapsible call transcript, then tap **`🩺 Arrived at the Clinic: Open Face-to-Face Mode (Carry Over Booking Info)`**.

#### Part 2: 180° Face-to-Face Consultation & Follow-Up (`/consult` — ~60 seconds)
1. **Prep Step 1/2**: Verify your saved booking is selected and choose a dialogue language pair (e.g., `🌐 EN Patient ⇄ JA Doctor`), then tap **`Next: Check Symptom Memo`**.
2. **Prep Step 2/2**: Confirm the carried-over symptom memo and saved quick phrase, then tap **`🩺 Start Face-to-Face Consultation`**.
3. **Active Consultation (180° Split Screen)**:
   - Observe the **top 180°-rotated Doctor panel** (with Push-to-Talk `Hold to Speak`) and the **bottom Patient chat timeline**.
   - Send a reply via **`💡 Open AI 3-Choice Replies ▲`** or type in the wide input field -> tap **`✨ AI Polish`** -> edit if desired -> tap **`📤 Show to Doctor`**, watching the rotated Doctor card update immediately.
   - Tap **`🤖 Next Question (Demo)`** in the center bar 1–2 times to advance through physical exam findings, prescriptions, and a 2-week follow-up instruction.
   - Tap **`✅ End & Summary`**.
4. **Structured Summary & Follow-Up**:
   - Review the structured **Chief Complaint**, **Findings & Allergies**, and **Prescriptions & Care Instructions**.
   - Verify the extracted **2-week follow-up date, time, and clinic address**, and tap **`Add Follow-Up to Google Calendar`**.
   - Tap **`Back to Home Hub`**—the **`📋 Past Bookings & Consultations`** section at the bottom of the Home Hub now displays your locally saved booking and consultation records with 1-tap handoff buttons.

---

## 4. Tech Stack & Verification

### Tech Stack
| Layer | Technologies |
|---|---|
| **Framework & UI** | **Next.js 16.4.5** (App Router, Turbopack), **React 19.3**, **TypeScript 5**, **Tailwind CSS 4**, `lucide-react` |
| **AI & Clinical Logic** | **`@google/genai`** (Gemini 2.5 Flash / Gemini 3.5 Flash Lite via API Key or Vertex AI ADC), `zod` schema validation, 4s timeout + deterministic clinical fallback (`server/careAiService.ts`) |
| **Speech (STT / TTS)** | Browser **Web Speech API** (`SpeechRecognition` & `speechSynthesis`) + optional **`@google-cloud/text-to-speech`** (Chirp 3 HD) & **`@google-cloud/speech`** |
| **Maps & Calendar** | **Google Maps URLs** (Directions & Search with landmark normalization), **Google Calendar Event URLs** (timed & all-day events with clinic address) — zero OAuth friction |
| **Local Persistence** | Browser **`localStorage`** with `useSyncExternalStore` reactive stores (bookings, consultations, language preference, and saved quick phrases) |

### Automated Verification (Zero Errors)
All **27 test suites (745 tests)**, strict TypeScript checks, ESLint rules, and production Next.js builds pass with **0 errors**:

```bash
# Run all 27 test files (745 unit, API, protocol & end-to-end UI integration tests)
npm test

# Strict TypeScript check (0 errors)
npx tsc --noEmit

# ESLint check (0 errors)
npm run lint

# Next.js 16.4.5 production build (0 errors)
npm run build
```

---

## 5. Optional Live AI Configuration & Deployment

EchoBridge Care works immediately without environment variables. To connect live **Gemini API** models and/or **Google Cloud Text-to-Speech**, create a `.env.local` (or `.env`) file in the project root:

### Option A: Gemini Developer API Key
```ini
GEMINI_API_KEY=your_gemini_api_key_here
```

### Option B: Google Cloud Vertex AI + Cloud TTS (ADC / Cloud Run)
```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project <YOUR_GCP_PROJECT_ID>
```
```ini
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=your_gcp_project_id
GOOGLE_CLOUD_LOCATION=global
# Optional: set TTS_ENABLED=false to always use browser speechSynthesis
```

### Production / Cloud Run Start
```bash
npm run build
NODE_ENV=production npm start
```

---

## 6. Project Structure

```text
echobridge-care/
├── src/
│   ├── app/
│   │   ├── page.tsx                  # Home Hub + 4-Step AI Clinic Booking Wizard + Local History
│   │   ├── consult/page.tsx          # 2-Step Prep + 180° Tabletop Consultation + Structured Summary
│   │   ├── join/page.tsx             # Partner browser WebSocket live call room (/join)
│   │   └── api/                      # Route Handlers (clinic-search, sandbox-reception, consult, polish-draft, tts)
│   ├── components/
│   │   ├── SandboxCallView.tsx       # Step 4 AI Receptionist Call + 2-Page Maps/Calendar Completion
│   │   ├── CustomPhrases.tsx         # Saved Quick Phrases manager (with default 1-phrase preset)
│   │   ├── QuickPhraseRail.tsx       # Horizontally swipeable quick phrase rail with scroll cues
│   │   └── AppointmentReviewCard.tsx # Editable Google Calendar & Maps preview card
│   └── lib/                          # Care types, localStorage stores, Maps/Calendar URLs, speech & draft polish
├── server/
│   ├── careAiService.ts              # Gemini clinical prompts + 4s timeout + deterministic local fallback
│   └── index.ts                      # Unified HTTP + WebSocket production server (Cloud Run ready)
└── tests/                            # 27 test files / 745 passing tests (Vitest + Testing Library)
```

---

## License

Released under the [MIT License](LICENSE).  
*Disclaimer: EchoBridge Care is an accessibility and medical communication support tool and does not provide medical diagnosis. Please do not enter real personal health information when testing on shared devices.*
