# Content review file: generic gasoline-engine misfire triage

- **Workflow:** `generic.gasoline-engine-misfire`, version 1.
- **Code:** `app/lib/diagnostic-workflow-content/workflows/generic-gasoline-misfire.ts`.
- **Content class:** `generic_source_backed`.
- **Review status: DRAFT. NOT HUMAN-REVIEWED.**
  - Assembled by an AI assistant (Claude) for CarCode, from the public sources
    below and general diagnostic structure.
  - No qualified automotive reviewer has checked it.
  - It must not be shown to users as diagnosis until the checklist at the end
    is completed and a human approval is recorded against its fingerprint.

## Purpose

Organize the diagnosis of a reported, reproducible engine misfire on a
gasoline engine into five coarse cause categories:

- find out whether one cylinder or several are affected;
- run the checks that separate the categories, within what the person can
  do;
- stop at a category, never a failed part the evidence did not reach;
- verify the repair with objective evidence.

## Intended applicability

- **Applies to:** vehicles whose fuel is `gasoline` (spark-ignition engines).
- **Does not start for:** diesel, electric or hybrid propulsion.
  - **Hybrids** are excluded on purpose, because the engine may not run on
    demand.
- **Unknown fuel:** the session does not start (insufficient context). It is
  never guessed.
- **No manufacturer, engine or model year is claimed.**

## Assumptions

- **One primary fault** (the engine's `single_primary_fault` model).
  Contradictory evidence ends the session as inconclusive.
- **The misfire can be reproduced now.** Otherwise the workflow stops at "not
  happening now" with advice on what to record.
- **The swap test** assumes each cylinder has its own coil (or lead) and an
  accessible spark plug. Where that is not so, the person answers "cannot do
  this" and the check is skipped. Skipping is not evidence.
- **The fuel pressure check** concerns the low-pressure supply side only.
  High-pressure direct-injection rails are out of scope.
- **Codes route only when reported as current:** pending, confirmed or
  active. A permanent or history code alone, or a typed code with unknown
  status, leads to asking the person instead.

## Cause categories

| Id | Category |
| --- | --- |
| `ignition` | Ignition (spark plug, coil or ignition lead) |
| `fuel_delivery` | Fuel delivery (supply pressure or injector) |
| `mechanical` | Mechanical (compression) |
| `air_intake` | Intake air leak |
| `electrical_connection` | Wiring or connector to an ignition or injection component |

## Structure

1. Is the misfire reproducible now?
   - If not: "not happening now" (not reproducible).
2. Is the check-engine light flashing?
   - If yes: refer, with the catalyst-damage warning.
3. Pattern:
   - from current codes (P0300 means several cylinders; P0301 to P0312 mean
     one);
   - otherwise asked;
   - otherwise read from per-cylinder live data, if the person has live-data
     access;
   - otherwise "read the codes first".
4. **One cylinder.** Secure the vehicle and let the engine cool. Then one
   reorderable region, `single_cylinder_tests`:

   | Check | Who | Profile |
   | --- | --- | --- |
   | Look at the wiring and connectors | owner | low risk, observe |
   | Swap coil and plug | DIY, code reader, hand tools | low, disconnect; never repeated after the repair |
   | Compare the spark plug | DIY, hand tools | low, disassemble |
   | Compare compression between cylinders | professional, compression tester | moderate, disassemble |

5. **Several cylinders.** Secure the vehicle. Then one reorderable region,
   `multiple_cylinder_tests`:

   | Check | Who | Profile |
   | --- | --- | --- |
   | Listen and look for an intake leak | owner | low, observe |
   | Fuel supply pressure against the vehicle's VERIFIED `fuel_supply_pressure_expected` | professional, pressure gauge | moderate, disconnect |

6. **Conclusion.** A category plus a recommendation that defers to the
   vehicle's service information, or "needs professional diagnosis" when the
   region is exhausted.
7. **Repair verification.** Three criteria, all required:
   - the detecting check passes again, where repeating it means something;
   - the symptom is gone in the conditions where it happened;
   - a COMPLETE post-repair scan does not list the earlier codes.

   The verdict follows the engine's rules:
   - a partial scan, or a code still listed only as permanent or history, is
     inconclusive;
   - the person's word alone never verifies a repair.

The engine's V2E ranking orders the checks (risk first, then separation,
decisiveness, invasiveness, set-up and capability fit). There are no
probabilities, costs or confidence scores.

## Sources

| Id | Source | Type (tier) | Consulted |
| --- | --- | --- | --- |
| `carb-13ccr-1968.2-fro` | CARB, Final Regulation Order, 13 CCR §1968.2 (OBD II), [arb.ca.gov/regact/obd02/fro1968-2.pdf](https://arb.ca.gov/regact/obd02/fro1968-2.pdf) | regulation (primary) | partial text, accessed 2026-10-16 |
| `sae-j2012-catalogue` | SAE J2012 catalogue entry, [saemobilus.sae.org/content/J2012_201612](https://saemobilus.sae.org/content/J2012_201612) | standard summary (primary) | catalogue page only |
| `ase-a8-task-list-2025` | ASE Study Guide 2025, Engine Performance (A8) task list, [ase.com](https://www.ase.com/uploads/ASE_Automobile_Study_Guide_2025_250109_210800.pdf) | technical education (secondary) | section A of the A8 task list |

Navigation only, and not cited as authority:

- the standards research on branch `research/guided-diagnostics-v2-standards`
  (`findings.md`);
- `app/data/dtc/ATTRIBUTION.md`.

## Which source supports which design choice

| Design choice | Support | Source and location |
| --- | --- | --- |
| A flashing light means misfire at a level that can damage the catalyst; some vehicles light it steadily instead | supported | CARB (e)(3.4.1)(A)(ii), (e)(3.4.1)(D) |
| "Avoid driving further than necessary" | CarCode inference from the above | none |
| OBD identifies the specific misfiring cylinder, with a separate code for several | supported | CARB (e)(3.1.2), (e)(3.1.3) |
| P0300 = random or multiple; P0301 to P0312 = cylinder 1 to 12 | **partly supported: identifiers not verified** | SAE J2012 catalogue only |
| Route only on pending, confirmed or active codes; a code never changes a cause | partly supported | CARB (c)(5), (c)(25), (d)(2.2.2), (d)(2.4) |
| Freeze-frame data is stored with codes (cited in "not happening now") | supported | CARB (d)(2.2.4), (e)(3.4.3)(B) |
| Test types: visual inspection, vacuum or pressure, compression and relative compression, leak-down, scope or scan diagnosis; the five categories as domains | partly supported (competencies, not procedures) | ASE A8 A.1, A.6 to A.10 |
| The swap test's and compression comparison's cause effects | author judgement | none |
| Findings that only point to a category (connector, plug, intake leak, low pressure) | author judgement | none |
| Fuel pressure judged only against a verified vehicle specification | author judgement (V2B design) | none |
| Test profiles, hazards and conditions | author judgement | none |
| Verification needs all three criteria | partly supported | CARB (d)(2.2.2), (d)(2.4) |

## Safety assumptions

- **Steps are gated by conditions, not prose.** Steps with the engine off
  need `vehicle_secured` and `engine_off_cool`; running-engine checks need
  `vehicle_secured`. The engine refuses a step whose conditions are not
  established.
- **Hazard notes are shown with each step:**
  - moving parts while running;
  - hot engine and exhaust parts;
  - ignition high voltage;
  - fuel under pressure and no open flames;
  - cranking safety for the compression test.
- **Lifting the vehicle is not needed** by any step.
- **Higher-risk checks need professional skill.** The compression comparison
  and the fuel pressure measurement are professional-level and need their
  instrument. The engine's capability gate decides who sees them.
- **All hazard text is author judgement** and must be checked by the
  reviewer.

## Vehicle-specific information deliberately excluded

- **Numeric specifications:** compression, fuel pressure, resistance, voltage
  and timing values. The only numbers are the version and a typo guard of
  0 to 1000 kPa on the fuel pressure reading, which is not a pass limit.
- **Manufacturer procedures:** command sequences, ECU addressing and service
  functions.
- **Manufacturer-specific code meanings.**
- **Per-vehicle layout:** component locations, firing orders and cylinder
  numbering.
- **High-pressure direct-injection tests.**

## Unresolved questions

1. **Code identifiers.** Are P0300 and P0301 to P0312 exactly right, and
   complete, against the current SAE J2012 digital annex? This was not
   verified.
2. **Swap test with a stayed misfire.** Should a misfire that stays put
   after a coil-and-plug swap rule out all of "ignition", or only the swapped
   parts? An ignition lead or boot on some designs stays with the cylinder.
3. **Compression comparison.** Should "clearly lower" have a stated basis or
   a reference method, or stay a professional judgement?
4. **Fuel pressure within specification.** Should it rule out fuel supply
   pressure (it currently rules out nothing), and how should "above
   specification" be handled?
5. **Hybrids.** Should hybrids with a gasoline engine get a variant? They
   are excluded now.
6. **Newer CARB edition.** The CARB edition consulted is old. Does a current
   edition change anything used here, in particular permanent fault codes?

## Known limitations

- **Two of the sources are partial:**
  - the CARB text read is one older edition;
  - the ASE task list gives competencies, not procedures.

  The SAE source is a catalogue page.
- **Coarse categories.** The workflow stops at a category; it does not
  identify a failed part.
- **Not tested on real vehicles.**
- **Fuel pressure cannot be judged yet.** No verified specification source
  exists in CarCode, so the step always routes away today.

## Review status

`draft`, `contentRevision: 1`, `preparedBy: ai_assisted`, `reviews: []`.

The validator refuses `source_reviewed` or `approved` without a recorded
human review whose `reviewedFingerprint` equals the current content
fingerprint. Any change to the diagnostic content makes an earlier approval
stale.

## Checklist for a qualified automotive reviewer

To be completed by a qualified person (for example an ASE-certified A8
technician or equivalent) before the status may change. Record name,
qualification, date, notes and the fingerprint reviewed.

**Technical correctness**
- [ ] Each claim in the metadata matches its cited source at the cited location.
- [ ] P0300 and P0301 to P0312 are correct and complete per the current SAE
  J2012 / J2012-DA.
- [ ] The five cause categories are appropriate and sufficient for triage.
- [ ] No step depends on vehicle-specific service information it does not ask
  for by specification id or defer to explicitly.

**Safety**
- [ ] Each step's hazard notes are correct, complete and not exaggerated.
- [ ] The conditions (`vehicle_secured`, `engine_off_cool`) are required where
  needed and established before use.
- [ ] Skill levels and instruments are right for each step (owner, DIY,
  professional).
- [ ] The flashing-light conclusion and its advice are appropriate.

**Sequence and prerequisites**
- [ ] The order of the fixed steps (reproducible, then flashing light, then
  pattern) is right.
- [ ] The checks in each region are genuinely interchangeable at that point.
- [ ] Each region's test profiles (risk, invasiveness, set-up) are reasonable.

**Cause effects**
- [ ] The swap test's effects (moved, stayed) are valid under one primary fault.
- [ ] "Clearly lower compression" justifies ruling out the other categories.
- [ ] Findings that only point to a category (and rule nothing out) are
  correctly limited.
- [ ] The behaviour for fuel pressure within or above specification is right.

**Applicability**
- [ ] Gasoline only, hybrids excluded, no other restriction: correct and
  conservative enough.

**Terminology**
- [ ] Prompts, titles and recommendations are accurate, plain and not
  misleading.

**Verification criteria**
- [ ] Each conclusion's verification re-checks the right detecting check.
- [ ] Symptom, re-check and complete post-repair scan are the right criteria.
- [ ] The handling of permanent, history and partial scans is appropriate.

**Vehicle-specific dependencies**
- [ ] Any step that in practice needs vehicle-specific data or procedures is
  marked so, or refers to the vehicle's service information.
