# replit.md

## Overview

CarCode AI is a Progressive Web App (PWA) for diagnosing vehicle issues using OBD-II trouble codes or symptom descriptions, powered by OpenAI. Users can enter a diagnostic trouble code (like P0300) or describe symptoms, select their vehicle (year/make/model/engine), and receive AI-generated diagnostic causes with severity levels, confirmation steps, and fix suggestions. The app includes a multi-vehicle garage system with maintenance record tracking, VIN decoding, multi-language support (7 languages), and Replit-based authentication.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: Next.js 16 with the App Router (`app/` directory structure)
- **Language**: TypeScript with React 19
- **Styling**: Tailwind CSS v4 with `@tailwindcss/postcss` plugin and `@tailwindcss/typography`
- **Rendering**: Client-side rendering for the main page (`"use client"` directive in `page.tsx`), with server-side API routes
- **React Compiler**: Enabled via `babel-plugin-react-compiler` and `reactCompiler: true` in next.config.ts
- **PWA**: Service worker (`public/sw.js`) with cache-first for static assets and network-first for API calls; includes `manifest.json` for installability
- **Fonts**: Geist Sans and Geist Mono loaded via `next/font/google`
- **Internationalization**: Custom translation system in `app/data/translations.ts` supporting 7 languages (en, es, fr, ar, pt, de, zh) with a `tr()` helper function

### Backend (API Routes)
All API routes live under `app/api/` using Next.js Route Handlers:

- **`/api/diagnose`** (POST) — Core diagnostic endpoint. Sends vehicle info + code/symptoms to OpenAI and returns structured JSON with causes, severity, difficulty, confirmation steps, and fixes
- **`/api/garage`** (GET + likely POST/PUT/DELETE) — CRUD for user's saved vehicles and maintenance records. Requires authentication
- **`/api/vehicles/makes`** (GET) — Autocomplete for vehicle makes using NHTSA VPIC API
- **`/api/vehicles/models`** (GET) — Autocomplete for vehicle models using NHTSA VPIC API, with optional year filtering
- **`/api/vehicles/engines`** (GET) — Engine option lookup using CarQuery API
- **`/api/vehicles/vin`** (GET) — VIN decoding using NHTSA VPIC API, returns year/make/model/engine suggestions
- **`/api/auth/*`** — Authentication flow (login, callback, logout, user info)
- **`/api/ping`** (GET) — Health check endpoint

### Authentication
- **Type**: Email/password authentication with bcrypt password hashing
- **Library**: `bcryptjs` for password hashing (12 rounds)
- **Session Management**: Custom session system with random 64-char hex session IDs stored in PostgreSQL, 7-day expiry, session ID stored in httpOnly cookies
- **Endpoints**: `/api/auth/login` (POST), `/api/auth/register` (POST), `/api/auth/logout` (GET/POST), `/api/auth/user` (GET)
- **UI**: Modal-based login/register form in the frontend (no page redirects)

### Database
- **Engine**: PostgreSQL via `pg` (node-postgres) library with a connection pool
- **Connection**: Uses `DATABASE_URL` environment variable
- **Schema** (auto-created on first use via `ensureDB()`):
  - `users` — id, email, first_name, last_name, profile_image, created_at
  - `sessions` — sid (PK), user_id (FK→users), expires_at, created_at
  - `garage_vehicles` — id, user_id (FK→users), year, make, model, engine, vin, is_active, created_at
  - `maintenance_records` — id, user_id (FK→users), vehicle_id (FK→garage_vehicles), type, date, mileage, notes, created_at
- **Pattern**: Raw SQL queries (no ORM), lazy schema initialization

### Data Layer
- **Common Codes**: Static dataset in `app/data/common-codes.ts` with ~40+ OBD-II codes including description, category, severity, and common causes. Used for quick reference/suggestions in the UI
- **Vehicle Data**: `app/data/engines.json` exists but appears empty; engine data comes from external APIs at runtime

### Dev Server
- Runs on `0.0.0.0:5000` (configured in package.json scripts for both dev and production)

## External Dependencies

### APIs & Services
- **OpenAI API** — Powers the diagnostic analysis. Requires `OPENAI_API_KEY` environment variable. Used via the official `openai` npm package (v6)
- **NHTSA VPIC API** — Free US government API for vehicle make/model lookups and VIN decoding (`vpic.nhtsa.dot.gov`). No API key needed
- **CarQuery API** — Used for engine/trim data lookup. Returns JSONP-wrapped responses that are parsed server-side
- **Replit OIDC** — Authentication provider. Requires `REPL_ID` environment variable (auto-set by Replit) and `ISSUER_URL` (defaults to `https://replit.com/oidc`)

### Environment Variables Required
- `OPENAI_API_KEY` — OpenAI API key for diagnostics
- `DATABASE_URL` — PostgreSQL connection string
- `REPL_ID` — Replit app ID (auto-provided)
- `REPLIT_DEV_DOMAIN` / `REPLIT_DOMAINS` — Used for constructing callback URLs (auto-provided by Replit)

### Key NPM Packages
- `next` (16.1.6) — Web framework
- `react` / `react-dom` (19.2.3) — UI library
- `openai` (6.x) — OpenAI SDK
- `pg` (8.x) — PostgreSQL client
- `bcryptjs` — Password hashing for authentication
- `react-markdown` (10.x) — Markdown rendering for AI responses
- `memoizee` — Function memoization
- `tailwindcss` (4.x) — CSS framework
- `@vercel/analytics` — Analytics (listed in lock file)