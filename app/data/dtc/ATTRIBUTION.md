# Trouble-code data: what is here and where it comes from

The rule for this folder: **a missing definition is better than a wrong one.**
Nothing is added here without a recorded source, and nothing is marked
`verified` unless it was checked against that source.

## generic.json — standardized (generic) codes

Codes whose meaning is fixed for every make by SAE J2012 / ISO 15031-6
(P0, P2, P3400-P3FFF, B0, C0, U0, U3).

Each entry has `code`, `title`, `source` and `verification`:

- `verified` — checked against a reliable, recorded source (for example licensed
  SAE J2012-DA data). **No entry has this status yet.**
- `curated` — a standardized title entered by hand for a very small set of the
  most common codes. Shown to users as a standard definition, never as "verified".

Current contents: 8 curated codes (P0011, P0016, P0171, P0300, P0420, P0455,
P0A80, U0100). Every other standardized code is handled, but reported as
"definition not verified".

To grow this file properly, license the SAE J2012 Digital Annex (J2012-DA) or a
commercial DTC data product and import from it, setting `verification` to
`verified` and `source` to the licensed dataset and version.

## manufacturer.json — manufacturer-specific codes

Codes in manufacturer-controlled ranges (P1, P3000-P33FF, B1, B2, C1, C2, U1,
U2) and makers' own code formats. Their meaning differs between makes, so every
record names its `make` and is only ever returned for that make.

Fields: `code`, `make`, `definition`, `source`, `sourceType`, `verification`,
and optionally `model`, `yearFrom`, `yearTo`, `chassis`, `engine`, `module`.
Only records with `verification: "verified"` are served.

Current contents: empty. There is no free, legally clean, comprehensive source
of manufacturer definitions; they come from the makers' service information or
from licensed data providers.

## Quarantined data

The previous database and the hard-coded BMW entries are in
`data/quarantine/` at the repository root, with the reasons. They are not
loaded by the app.
