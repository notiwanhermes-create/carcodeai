# replit.md

## Overview

CarCode AI is a Progressive Web App (PWA) for diagnosing vehicle issues using OBD-II trouble codes or symptom descriptions, powered by OpenAI. Users can enter a diagnostic trouble code (like P0300) or describe symptoms, select their vehicle (year/make/model/engine), and receive AI-generated diagnostic causes with severity levels, confirmation steps, and fix suggestions. The app includes a multi-vehicle garage system with database-backed maintenance record tracking, VIN decoding, and multi-language support (7 languages). Dark-only glassmorphism interface. Authentication via NextAuth (Auth.js) with email/password and Google OAuth.

## User Preferences

- Preferred communication style: Simple, everyday language.
- Dark mode only, port 5000, Garage tab first
- All dropdowns filter as you type in same field (no separate search bar)
- Only show real car makes (~70 brands) and passenger car models (no motorcycles/bikes)
- NextAuth + Prisma + database-backed garage + maintenance per user

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
- **Components**: `ComboSelect` uses absolute positioning for dropdowns with filter-as-you-type in the same input field

### Backend (API Routes)
All API routes live under `app/api/` using Next.js Route Handlers:

- **`/api/diagnose`** (POST) — Core diagnostic endpoint. Sends vehicle info + code/symptoms to OpenAI and returns structured JSON with causes, severity, difficulty, confirmation steps, and fixes
- **`/api/garage`** (GET/POST) — List and create vehicles (database-backed via Prisma). Requires NextAuth session
- **`/api/garage/[id]`** (DELETE) — Delete a vehicle and cascade-delete its maintenance records. Requires NextAuth session
- **`/api/maintenance`** (GET/POST) — List and create maintenance records per vehicle. Requires NextAuth session
- **`/api/maintenance/[id]`** (DELETE) — Delete a maintenance record. Requires NextAuth session
- **`/api/vehicles/makes`** (GET) — Autocomplete for vehicle makes using NHTSA VPIC API, filtered to ~70 known car brands via KNOWN_CAR_MAKES set
- **`/api/vehicles/models`** (GET) — Autocomplete for vehicle models using NHTSA VPIC API, filtered to passenger cars only (vehicletype=2)
- **`/api/vehicles/engines`** (GET) — Engine option lookup using CarQuery API
- **`/api/vehicles/vin`** (GET) — VIN decoding using NHTSA VPIC API, returns year/make/model/engine suggestions
- **`/api/feedback`** (POST) — Saves user feedback (name, email, rating, message) to PostgreSQL
- **`/api/auth/[...nextauth]`** — NextAuth authentication endpoints (login, register, Google OAuth, session management)
- **`/api/ping`** (GET) — Health check endpoint

### Authentication
- **Library**: NextAuth (Auth.js) v5 with JWT strategy
- **Providers**: Credentials (email/password with bcrypt hashing) + Google OAuth
- **Registration**: Custom Credentials provider named "register" that creates new users
- **Session**: JWT-based sessions, no database session table needed
- **Google OAuth**: Uses `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` secrets. Links Google accounts with existing email accounts automatically.
- **Pages**: Dedicated `/login` and `/signup` pages with dark glassmorphism theme (not modals)
- **Protected Routes**: `/dashboard` redirects to `/login` if not authenticated
- **Config**: `app/lib/auth-config.ts` exports NextAuth handlers and auth helper

### Database
- **Engine**: PostgreSQL (Neon-backed via Replit)
- **ORM**: Prisma 7 with `@prisma/pg` adapter
- **Connection**: Uses `DATABASE_URL` environment variable
- **Config**: `prisma/schema.prisma` for schema, `prisma.config.ts` for Prisma config with PrismaPg adapter
- **Schema**:
  - `users` — id (cuid), email (unique), password_hash, google_id, first_name, last_name, profile_image, created_at
  - `sessions` — sid (PK), user_id (FK→users), expires_at, created_at
  - `garage_vehicles` — id (cuid), user_id (FK→users), year, make, model, engine, vin, nickname, is_active, created_at
  - `maintenance_records` — id (cuid), user_id (FK→users), vehicle_id (FK→garage_vehicles), type (maps to serviceType), mileage (maps to odometer), date, notes, cost, created_at
  - `feedback` — id (autoincrement), name, email, rating, message, page, created_at
- **Pattern**: Prisma Client queries, `@map()` for snake_case database columns, generated client at `app/generated/prisma`
- **Migration**: Uses `prisma db push` (no migration files)

### Data Layer
- **Common Codes**: Static dataset in `app/data/common-codes.ts` with ~40+ OBD-II codes including description, category, severity, and common causes
- **Vehicle Data**: Engine data comes from external APIs at runtime

### Pages
- `/` — Main page with onboarding splash, tabs for Garage/Diagnostics/Code Library
- `/login` — Login page with email/password + Google OAuth
- `/signup` — Registration page with first/last name, email, password + Google OAuth
- `/dashboard` — Protected page with garage management and maintenance records

### Dev Server
- Runs on `0.0.0.0:5000` (configured in package.json scripts for both dev and production)

## External Dependencies

### APIs & Services
- **OpenAI API** — Powers the diagnostic analysis. Requires `OPENAI_API_KEY` environment variable. Used via the official `openai` npm package (v6)
- **NHTSA VPIC API** — Free US government API for vehicle make/model lookups and VIN decoding (`vpic.nhtsa.dot.gov`). No API key needed
- **CarQuery API** — Used for engine/trim data lookup. Returns JSONP-wrapped responses that are parsed server-side

### Environment Variables Required
- `OPENAI_API_KEY` — OpenAI API key for diagnostics
- `DATABASE_URL` — PostgreSQL connection string
- `GOOGLE_OAUTH_CLIENT_ID` — Google OAuth client ID
- `GOOGLE_OAUTH_CLIENT_SECRET` — Google OAuth client secret
- `NEXTAUTH_SECRET` — NextAuth session encryption secret (auto-generated if not set)
- `REPLIT_DEV_DOMAIN` / `REPLIT_DOMAINS` — Used for constructing callback URLs (auto-provided by Replit)

### Key NPM Packages
- `next` (16.x) — Web framework
- `react` / `react-dom` (19.x) — UI library
- `next-auth` (5.x) — Authentication library
- `prisma` / `@prisma/client` / `@prisma/pg` — ORM and PostgreSQL adapter
- `openai` (6.x) — OpenAI SDK
- `bcryptjs` — Password hashing for authentication
- `react-markdown` (10.x) — Markdown rendering for AI responses
- `memoizee` — Function memoization
- `tailwindcss` (4.x) — CSS framework
