# EchoBridge Care

**End-to-End Medical Accessibility & Cross-Lingual Healthcare Communication App**  
**発話・聴覚障がいのある方や外国人患者のための「病院検索・AI予約電話 〜 対面診察 〜 再診登録」一気通貫支援アプリ**

![Next.js](https://img.shields.io/badge/Next.js-16.4.5-black?logo=next.js)
![React](https://img.shields.io/badge/React-19.3-149eca?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript)
![Tests](https://img.shields.io/badge/Tests-27%20files%20%7C%20745%20passing-0d9488)
![License](https://img.shields.io/badge/License-MIT-slate)

---

## 1. Overview / プロジェクト概要

### English
**EchoBridge Care** empowers patients with speech or hearing difficulties (e.g., dysarthria, stuttering, laryngectomy, hard-of-hearing) as well as international patients facing language barriers to navigate healthcare independently—from **booking a clinic appointment by phone**, to **communicating face-to-face with a doctor in the exam room**, to **understanding prescriptions and scheduling follow-up visits**.

Every screen supports instant **Japanese / English (`🇯🇵 日本語` / `🇺🇸 English`)** UI switching, interactive **visual guidance cues** (shimmer & micro-vibration on the next recommended action), and a **zero-config Local Demo Mode** so judges and reviewers can test the entire workflow on a single browser with no API keys required.

### 日本語サマリー
**EchoBridge Care** は、構音障害・吃音・喉頭摘出・聴覚障がいなどで「声での電話や診察室でのやり取り」にハードルがある方や、日本語での受診が不安な外国人患者（および海外で英語受診する日本人旅行者）のために設計された医療アクセシビリティ＆多言語コミュニケーション支援Webアプリです。

**「病院を探してAI音声で予約電話をかける（`/`）」➔「Google Mapsで病院へ向かう」➔「診察室の机にスマホを置いて180度反転画面で医師と対話する（`/consult`）」➔「診察内容の構造化サマリーを確認し、再診予定をGoogle Calendarへ登録する」** という受診体験のすべてを、サーバーに個人医療情報を残さないプライバシー重視設計で一気通貫に繋ぎます。

---

## 2. Key Features / 主な機能

### 🏥 1. 4-Step AI Mock Clinic Booking Call (`/` — Booking Wizard)
- **Step 1 — Symptom & Preference Input**: Enter chief complaint, clinical department, preferred area, origin point for directions, and top-3 preferred time slots. Includes 1-tap **`[Fill Example / 例を入力]`** (auto-fills area & station origin so Maps works without GPS) and **`[✨ AI Polish / AIブラッシュアップ]`** to refine rough notes into polite clinical phrasing while keeping text freely editable.
- **Step 2 — AI Triage & Clinic Selection**: Displays organized symptoms, recommended departments, and matching clinics—with a pinned **`[For Review/Testing] EchoBridge Care Mock Clinic`** at the top for safe, instant in-browser call testing (no real PSTN calls placed).
- **Step 3 — Opening Message & Saved Phrases**: Auto-generates the opening greeting from Steps 1–2, lets users choose synthesized voice gender, and manages **`📌 Saved Phrases / 登録文`** (pre-seeded with 1 default accessibility phrase on first visit, with a prominent confirm button plus auto-save of uncommitted drafts when starting the call).
- **Step 4 — Real-Time AI Receptionist Call & 2-Page Completion**:
  - Live synthesized Japanese TTS conversation with English translation subtitles, a collapsible **AI 3-Choice Replies** drawer, a horizontally swipeable **Quick Phrases** bar separated from **`📌 Saved Phrases (N)`**, and a **2-row wide input bar** (`w-full` text input on top + `[🎤 Voice / ✨ AI Polish / 📤 Send]` below).
  - **Completion Page 1 (Directions)**: Saves the booking locally and generates consistent **Google Maps Directions** & **Area Map** links anchored to real-world station/address coordinates.
  - **Completion Page 2 (Calendar & Handoff)**: **Google Calendar** 1-tap registration, collapsible call transcript, and a seamless **`🩺 Open Face-to-Face Mode`** handoff button that carries booking details directly into `/consult`.

### 🩺 2. Tabletop 180° Flipped Face-to-Face Consultation Mode (`/consult`)
- **Compact 2-Step Pre-Consult Setup**:
  - **Prep Step 1**: Choose conversation language pair (`🇯🇵 JA ⇄ JA`, `🌐 EN Patient ⇄ JA Doctor`, or `✈️ JA Patient ⇄ EN Doctor`) and optionally import a saved booking record.
  - **Prep Step 2**: Review/polish symptom & allergy memo and confirm saved quick phrases before entering the exam room.
- **Asymmetric Doctor / Patient Split-Screen UX**:
  - **Doctor Side (Top, rotated `180°` for across-the-desk viewing)**: High-contrast display of the patient's confirmed message in the doctor's language, TTS replay, and a **Push-to-Talk (`Hold to Speak / 押している間だけ録音`)** mic button to prevent accidental ambient recording in clinical settings—paired with a **`🤖 Next Question (Demo)`** button so a single reviewer can advance realistic multi-turn doctor questions with one tap.
  - **Patient Side (Bottom, upright)**: Scrollable **bilingual chat timeline** (doctor on left with original + translation, patient on right), collapsible **AI 3-Choice Replies** drawer, swipeable **Quick Phrases** + **`📌 Saved Phrases`** toggle, and a **2-row wide input bar** (`w-full` input + **toggle-style `🎤 Voice`** + editable **`✨ AI Polish`** + explicit **`📤 Show to Doctor`** confirmation).

### 📋 3. Structured Medical Summary & Evidence-Based Follow-Up Calendar
- **Clinical Bullet-Point Summary**: Automatically distills the consultation into three structured sections—**(1) Chief Complaint**, **(2) Exam Findings & Allergies/History** (filtering out raw doctor questions), and **(3) Prescriptions, Care Instructions & Follow-Up Guidance**—in Japanese and English.
- **Strict Follow-Up Date/Time Extraction**: Extracts follow-up timing strictly from spoken evidence (never fabricating a clock time—defaulting to an **All-Day Event** when no specific hour was mentioned, or pre-filling exact times when stated) and pre-populates both clinic name and editable clinic address into the **Google Calendar** URL.
- **Home Hub History (`📋 Past Bookings & Consultations`)**: Displays compact counts and latest visit previews on the top hub (`/`), expanding to full history cards with 1-tap **Re-book** or **Resume in Face-to-Face Consult** handoffs.

### 🔒 4. Privacy-First Local Storage & Zero-Key Local Demo Mode
- **No Server-Side Medical Persistence**: Sensitive medical notes, call transcripts, saved phrases,予約履歴 (booking history), and 受診記録 (consultation summaries) are stored **strictly in browser `localStorage`**—never saved to an external database.
- **Instant Local Demo Fallback**: All AI endpoints enforce a **4-second timeout** and automatically fall back to a deterministic clinical response engine when `GEMINI_API_KEY` / Vertex AI credentials are not configured. An explicit header badge (`Gemini Live AI` vs. `Local Demo Mode`) always indicates the active mode.
- **Two-Browser Live Web Call (`/join`)**: Also retains browser-to-browser WebSocket live relay rooms (`/` legacy call room & `/join`) for live two-device human testing.

---

## 3. Quick Start & 2-Minute Judge Walkthrough / クイックスタート＆審査員向けデモ手順

### Quick Start (No `.env` or API Keys Required!)

```bash
# 1. Install dependencies
npm install

# 2. Start the development server (runs immediately in Local Demo Mode if no API key is set)
npm run dev
```

Open **`http://localhost:3000`** in Chrome, Edge, or Safari.  
*(No `.env.local` file, database setup, or login is required to test every feature end-to-end.)*

---

### ⏱️ 2-Minute End-to-End Judge Walkthrough / 最短2分通しデモ手順

Follow the **glowing teal buttons (shimmer + subtle micro-vibration)** at each step—they highlight the exact primary action to tap next:

#### Part A: AI Phone Booking & Directions (`/` — ~60 sec)
1. **Top Hub (`/`)**: Toggle `🇺🇸 English` or `🇯🇵 日本語` at the top if desired, then tap **`🏥 Find a Clinic & Book by AI Phone / 病院を探す・AIで予約電話する`**.
2. **Step 1/4 (Symptoms & Area)**: Tap **`[Fill Example / 例を入力]`** to auto-fill symptoms, department, area (`Around Shinjuku Station / 新宿駅周辺`), and origin (`Shinjuku Station / 新宿駅`). *(Optional: edit text and tap **`✨ AI Polish`** to see clinical phrasing refinement.)* Tap **`Next: Search Clinics`**.
3. **Step 2/4 (Clinic Candidates)**: Tap **`Select This Mock Clinic & Prepare Call`** on the pinned top sandbox clinic card.
4. **Step 3/4 (Pre-Call Check)**: Review the auto-generated opening message (note that 1 default accessibility phrase is already pre-loaded in Saved Phrases) and tap **`Start AI Booking Call`**.
5. **Step 4/4 (Live AI Call)**:
   - Listen to / read the AI receptionist's reply.
   - Tap **`💡 Open AI 3-Choice Replies ▲`** to send a 1-tap contextual answer, or try **`📌 Saved Phrases (1)`**, the swipeable **Quick Phrases** rail, or the **2-row wide input bar** (`🎤 Voice` / `✨ AI Polish` / `📤 Send`).
   - Tap **`End Call & View Appointment / Directions`** (or `End Call & Review` in the header).
6. **Completion Pages 1 ➔ 2**:
   - **Page 1**: Verify **`Open Directions in Google Maps`** (origin pre-set to `Shinjuku Station`) and **`View Area Map`**, then tap **`[Next: Proceed to Google Calendar Registration →]`**.
   - **Page 2**: Check the **Google Calendar** preview and collapsible call transcript, then tap **`🩺 Arrived at the Clinic: Open Face-to-Face Mode (Carry Over Booking Info)`**.

#### Part B: 180° Face-to-Face Consultation & Follow-Up (`/consult` — ~60 sec)
1. **Prep Step 1/2**: Confirm your saved booking is selected and choose a language pair (e.g., `🇯🇵 JA ⇄ JA` or `🌐 EN ⇄ JA`), then tap **`Next: Check Symptom Memo`**.
2. **Prep Step 2/2**: Confirm the carried-over symptom memo & preset saved phrase, then tap **`🩺 Start Face-to-Face Consultation`**.
3. **Active Consultation (180° Split View)**:
   - Observe the **top 180°-rotated Doctor panel** and **bottom Patient chat timeline** (the doctor's opening question appears automatically).
   - Tap **`💡 Open AI 3-Choice Replies ▲`** (or type in the wide input -> **`✨ AI Polish`** -> **`📤 Show to Doctor`**) and watch the top 180° Doctor card update immediately.
   - Tap **`🤖 Next Question (Demo) / 次の質問(デモ用)`** in the center bar 1–2 times to simulate the doctor's physical exam findings, prescription, and 2-week follow-up instruction.
   - Tap **`✅ End & Summary / 診察終了・要約へ`**.
4. **Consultation Summary & Follow-Up**:
   - Review the structured **Chief Complaint**, **Findings & Allergies**, and **Prescriptions & Care Instructions**.
   - Confirm the auto-extracted **2-week follow-up date, time, and clinic address**, and tap **`Add Follow-Up to Google Calendar`**.
   - Tap **`Back to Home Hub / トップへ戻る`**—notice **`📋 Past Bookings & Consultations`** at the bottom of the Home Hub now stores both your booking and consultation records locally!

---

## 4. Tech Stack & Verification / 技術スタック＆品質保証

### Tech Stack
| Layer | Technologies |
|---|---|
| **Framework & UI** | **Next.js 16.4.5** (App Router, Turbopack), **React 19.3**, **TypeScript 5**, **Tailwind CSS 4**, `lucide-react` |
| **AI & Clinical Logic** | **`@google/genai`** (Gemini 2.5 Flash / Gemini 3.5 Flash Lite via API Key or Vertex AI ADC), `zod` structured schema validation, 4s timeout + deterministic local clinical fallback (`server/careAiService.ts`) |
| **Speech (STT / TTS)** | Browser **Web Speech API** (`SpeechRecognition` & `speechSynthesis`) + optional **`@google-cloud/text-to-speech`** (Chirp 3 HD) & **`@google-cloud/speech`** |
| **External Integrations** | **Google Maps URLs** (Directions & Search with landmark normalization), **Google Calendar Event URLs** (timed & all-day events with clinic address) — zero OAuth/API key friction |
| **Persistence** | Privacy-first browser **`localStorage`** (`useSyncExternalStore` reactive stores for bookings, consultations, language, and custom phrases) |

### Quality Assurance & Automated Verification
All **27 test suites (745 tests)**, TypeScript strict checks, ESLint rules, and Next.js production builds pass with **0 errors**:

```bash
# Run all 27 test files (745 unit, API, protocol & end-to-end UI integration tests)
npm test

# TypeScript strict type check (0 errors)
npx tsc --noEmit

# ESLint check (0 errors)
npm run lint

# Production build verification (Next.js 16.4.5)
npm run build
```

---

## 5. Optional Live AI Configuration & Deployment / 実AI連携・デプロイ設定（任意）

EchoBridge Care works out of the box without environment variables. To enable **Gemini Live AI** responses and/or **Google Cloud Text-to-Speech**, create a `.env.local` (or `.env`) file in the project root:

### Option A: Gemini Developer API Key (Simplest)
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
# Optional: disable Cloud TTS to always use browser speechSynthesis
# TTS_ENABLED=false
```

### Production / Cloud Run Start
```bash
npm run build
NODE_ENV=production npm start
```

---

## 6. Project Structure / ディレクトリ構成

```text
echobridge-care/
├── src/
│   ├── app/
│   │   ├── page.tsx                 # Top Hub + 4-Step AI Clinic Booking Wizard + Local History
│   │   ├── consult/page.tsx         # 2-Step Prep + 180° Tabletop Consultation + Structured Summary
│   │   ├── join/page.tsx            # Partner browser WebSocket room (/join)
│   │   └── api/                     # Next.js Route Handlers (clinic-search, sandbox-reception, consult, polish-draft, tts)
│   ├── components/
│   │   ├── SandboxCallView.tsx      # Step 4 AI Receptionist Call + 2-Page Maps/Calendar Completion
│   │   ├── CustomPhrases.tsx        # Saved Quick Phrases manager (with default 1-phrase preset)
│   │   ├── QuickPhraseRail.tsx      # Horizontally swipeable quick phrase rail with scroll hint
│   │   └── AppointmentReviewCard.tsx# Editable Google Calendar & Maps preview card
│   └── lib/                         # Care types, localStorage stores, Maps/Calendar URL builders, speech & draft polish
├── server/
│   ├── careAiService.ts             # Gemini structured medical prompts + 4s timeout + deterministic local fallback
│   └── index.ts                     # Unified HTTP + WebSocket production server (Cloud Run compatible)
└── tests/                           # 27 test suites / 745 tests (Vitest + Testing Library)
```

---

## License / ライセンス

Released under the [MIT License](LICENSE).  
*Disclaimer: EchoBridge Care is a communication and accessibility support tool and does not provide medical diagnosis. Please do not enter real personal health information when testing in shared demo environments.*
