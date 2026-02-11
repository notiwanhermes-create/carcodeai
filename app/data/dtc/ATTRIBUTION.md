# DTC Definitions – Data Source and Attribution

The Diagnostic Trouble Code (DTC) definitions used in this project are derived from the following public and standardized sources:

## Standards

- **SAE J2012** – Diagnostic Trouble Code Definitions (Society of Automotive Engineers). Defines standardized OBD-II DTCs for vehicles sold in the United States (1996 and later).
- **ISO 15031-6** – Road vehicles – Communication between vehicle and external equipment – Part 6: Diagnostic trouble code definitions (technically equivalent to SAE J2012).

The 2002 version of SAE J2012 has been incorporated by reference into the U.S. Code of Federal Regulations and is publicly available as a legally binding document.

## Data in This Repository

- **`definitions.json`** – Curated subset of DTCs with full metadata (code, system, standard, title, description, source). Used as the canonical source for key codes (e.g. P0300, P0420, P0171, P0455).
- **Legacy `../dtc-database.json`** – Broader code-to-title mapping used as a fallback for generic P0xxx (and other) codes. Titles align with SAE J2012 / ISO 15031-6 wording where applicable.

## License

Definitions are based on standardized, publicly referenced specifications. No proprietary SAE or ISO material is reproduced in full. Use of short definition titles and descriptions for interoperability and user assistance is consistent with common practice in automotive repair and OBD-II tools.

If you are a standards body or rights holder and believe attribution or licensing should be adjusted, please open an issue.
