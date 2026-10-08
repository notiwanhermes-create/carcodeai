# Trouble-code data: what is here and where it comes from

The rule for this folder: **a missing definition is better than a wrong one.**
Nothing is added here without a recorded source, and nothing is marked
`verified` unless it was taken from, and checked against, a source we are
licensed to use.

## How a code is classified (an assumption, not verified data)

`app/lib/dtc.ts` decides whether a code is standardized, manufacturer-specific
or uncertain from its first two characters. Those rules were **not** taken from
SAE J2012 or its Digital Annex (J2012-DA; the current revision when this was
written was `J2012DA_202607`). They restate the block-level layout that freely
available descriptions of the standard agree on:

| Second character | Classification |
|---|---|
| 0 (P0, B0, C0, U0) | standardized |
| 1 (P1, B1, C1, U1) | manufacturer-specific |
| 2 | P2 standardized; B2, C2, U2 manufacturer-specific |
| 3 (P3, B3, C3, U3) | **uncertain** |

Group 3 is uncertain on purpose. Public summaries describe P3 and U3 as partly
manufacturer controlled and partly reserved for ISO/SAE without agreeing on the
exact sub-ranges, and describe B3 and C3 as reserved. Rather than guess, the
app says it cannot confirm what kind of code it is.

Still assumed, and to be checked against licensed data: that no sub-range
inside P0, P2, B0, C0 or U0 is manufacturer controlled, that none inside P1,
B1, B2, C1, C2, U1 or U2 is standardized, and that the last three characters
are hexadecimal (which makes P0A80 an ordinary P0 code).

## sources.ts: the list of data sources

`sources.ts` is the only place data is plugged in. Each source has one role.
`buildRegistry` in `app/lib/dtc.ts` checks every record and leaves out any that
fail (no source, wrong range for the role, not verified, and so on), so adding
a provider never needs a change to the lookup code.

Two provider roles are planned. **Neither has been purchased or integrated.**

| Role | Intended provider | What it supplies |
|---|---|---|
| `standardized` | SAE J2012-DA (Digital Annex) | Authoritative definitions of standardized codes |
| `manufacturer` | A licensed OEM data provider such as MOTOR, or makers' own service information | Definitions that belong to one make |

To add one later:

1. Convert the provider's file into records in the shapes below, with
   `verification: "verified"` and a `source` that names the dataset and its
   version.
2. Add one entry to `DTC_SOURCES` in `sources.ts`. Put a standardized source
   above the hand-entered core so that it takes priority.
3. Run the tests. `buildRegistry(DTC_SOURCES).rejected` must be empty.
4. If the provider also defines exact ranges, pass its rule table to
   `buildRegistry` in place of `PUBLIC_SCOPE_RULES`.

**Licensed data must not be committed to a public repository.** This
repository is public. Before adding either provider, decide where the files
will live (a private repository, or storage read at build time) and confirm
that the licence allows the definitions to be shown to end users.

## generic.json: standardized codes (source id `curated-core`)

Each entry has `code`, `title`, `source` and `verification`:

- `verified`: taken from a licensed source. **No entry has this status yet.**
- `curated`: a title entered by hand. Shown to users as a standard definition,
  never as "verified".

Current contents: 8 hand-entered codes (P0011, P0016, P0171, P0300, P0420,
P0455, P0A80, U0100). They were written from the widely published titles of
these codes and have **not** been checked against licensed SAE data. This set
is deliberately small and is not to be extended by hand.

Every other code in a standardized block is reported as "Definition not
verified yet". The app does not show a definition for it and does not ask the
AI model to supply one.

## manufacturer.json: manufacturer-specific codes (source id `manufacturer-store`)

Fields: `code`, `make`, `definition`, `source`, `sourceType`, `verification`,
and optionally `model`, `yearFrom`, `yearTo`, `chassis`, `engine`, `module`.

- Only records with `verification: "verified"` are served, and only for the
  make they name.
- The optional fields are stored but not yet used to choose a record. If one
  make has two different meanings on file for a code, neither is served.

Current contents: empty. There is no free, legally clean, comprehensive source
of manufacturer definitions.

## Quarantined data

The previous database and the hard-coded BMW entries are in
`data/quarantine/` at the repository root, with the reasons. They are not
loaded by the app.
