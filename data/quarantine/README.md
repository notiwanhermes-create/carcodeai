# Quarantined trouble-code data

Nothing in this folder is loaded by the app.

- `dtc-database.unverified.json` — the former `app/data/dtc-database.json` (3,082 entries).
  It was served for every make as "SAE J2012 / ISO 15031-6" data, but:
  - 2,589 entries are in manufacturer-controlled ranges (P1, B1, B2, C1, C2, U1, U2) with no
    manufacturer recorded. About 300 use Ford-style wording; the rest cannot be attributed.
  - The 493 entries in standardized ranges contain runs of definitions shifted by one code
    (for example P0234 carries P0233's text, P0401 carries P0400's, P0136-P0141 are all one
    off) and at least one maker-specific text (P0563). Its origin is not recorded.
- `oem-bmw-seed.unverified.json` — four hard-coded BMW entries with no recorded source.

To bring data back: add it to `app/data/dtc/generic.json` or
`app/data/dtc/manufacturer.json` with a real `source`, and only after checking it against
that source. See `app/lib/dtc.ts` for the rules.
