# Guided Diagnostics v2: findings from public standards and literature

Research only. Branch `research/guided-diagnostics-v2-standards`. Nothing in
the product changes.

## How to read this

Each finding has:

- **Source**: where it comes from (links in the list at the end).
- **Evidence**: what the source says, paraphrased.
- **Status**:
  - OBSERVED: the source states it.
  - INFERRED: our reading of what the source implies.
  - UNKNOWN: the source does not settle it.
- **Confidence**: HIGH, MEDIUM or LOW.
- **CarCode implication**: what it means for us. This is always *our
  recommendation*, never part of the standard.

### Limits of the evidence

- **Paywalled standards.** The full normative texts of ISO 22901 (ODX),
  ISO 13209 (OTX), ISO 14229 (UDS), ISO 15031 and SAE J2012 / J1979 are
  paid and were **not** consulted. These findings rest on official abstracts
  and catalogue pages (ISO, SAE, ASAM), ASAM's public wiki and reports, a
  regulator's public documents, and peer-reviewed literature.
- **Vendor and secondary pages.** A few points come from tool-vendor
  pages (Sontheim, IME/Actia) and one community reference (Wikipedia, OBD-II
  services). They are marked MEDIUM or LOW.
- **No proprietary software.** No proprietary diagnostic software or data was
  examined.

---

## 1. Vehicle context

**F1.1 Vehicle identification is part of the diagnostic data model.**
- Source: [S1] ASAM MCD-2 D wiki.
- Evidence: ODX has a package for vehicle information. It holds make, model
  and type, the diagnostic connector and how logical links reach each control
  unit.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: vehicle context is a first-class input to a
  diagnosis, not free text. We already have year, make, model and engine
  (Phase 2A/2E). v2 should treat it as structured input to *applicability*
  (which workflows and specifications apply), not only to branching.

**F1.2 Generic OBD exposes standard vehicle information.**
- Source: [S8] Wikipedia OBD-II PIDs; [S7] ISO 15031-5 abstract.
- Evidence: the standard OBD services include a vehicle-information service
  (VIN, calibration IDs, control-unit name). ISO 15031-5 defines the messages
  and explicitly does **not** state which services or parameters apply to a
  given vehicle; the user must check applicability.
- Status: OBSERVED. Confidence: MEDIUM for the service list (secondary
  source), HIGH for the applicability caveat (ISO abstract).
- CarCode implication: even the generic layer has variable support per
  vehicle. Applicability has to be data, never assumed.

## 2. Control-unit (ECU) context

**F2.1 Control units are described in layers, from general to specific.**
- Source: [S1].
- Evidence: ODX organises diagnostic descriptions in layers:
  1. protocol;
  2. functional group;
  3. base variant;
  4. specific ECU variant.

  Each layer inherits from the one above and can override or remove. The data
  also says how to identify which variant a vehicle actually has.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: "generic content, then specialised by vehicle" is the
  industry pattern. For CarCode, the useful part is the *idea*: a generic
  workflow with vehicle-specific overrides supplied separately. Building
  ODX-style inheritance ourselves is not warranted (see the gap analysis).

**F2.2 Function-level grouping sits above control units.**
- Source: [S1].
- Evidence: ODX's function dictionary maps data, trouble codes and related
  environment data from several control units onto one vehicle *function*,
  arranged hierarchically. It adds no new capability; it lets a tester work
  by function rather than by control unit.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: owners think in functions and symptoms ("engine runs
  rough", "AC is warm"), not control units. Organising workflows by vehicle
  function/system is consistent with industry practice and with our users.

## 3. Trouble codes (DTCs)

**F3.1 Generic DTCs have a defined structure and an optional failure-type byte.**
- Source: [S4] SAE J2012 catalogue pages.
- Evidence: J2012 defines the generic trouble codes OBD systems must report.
  It is technically equivalent to ISO 15031-6. Its digital annex lists code
  definitions and *failure type* definitions. The failure type is a subtype
  that applies only when three-byte codes are used.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: a code is not always just "P0301". A matcher in a
  workflow should be able to say "this code, any failure type" or "this code
  with this failure type". Today we match exact strings only.

**F3.2 Codes carry a status, not just presence.**
- Source: [S6] CARB 13 CCR 1968.2 (public regulation documents); [S8].
- Evidence:
  - Regulators distinguish a *confirmed* fault code (stored once a
    malfunction is confirmed, typically on the second driving cycle that
    detects it) from codes detected but not yet confirmed (the standard OBD
    services include a separate *pending* codes service).
  - Separately, *permanent* codes can only be erased when the system itself
    determines the fault is no longer present (or under conditions after a
    clear).
- Status: OBSERVED (confirmed, permanent); MEDIUM for pending (from the
  services list).
- CarCode implication: "is the code present?" is too coarse. Pending versus
  confirmed matters for branching, and permanent-code behaviour matters for
  **repair verification** (F12.1).

**F3.3 Codes come with context recorded when they were set.**
- Source: [S1]; [S8].
- Evidence:
  - ODX supports reading codes together with related environment data.
  - Generic OBD has a *freeze frame* service: a snapshot of data captured
    when a code was set.
- Status: OBSERVED. Confidence: HIGH (ODX), MEDIUM (freeze frame).
- CarCode implication: freeze-frame values (load, speed, temperature when the
  fault happened) are evidence. v2 evidence should be able to carry them, so
  a branch can ask "did it happen cold or warm?" from data instead of asking
  the user.

**F3.4 A code's definition is separate data, and not every code is generic.**
- Source: [S4]; [S7].
- Evidence:
  - J2012 and its digital annex carry generic definitions.
  - ISO 15031-5 places parameter and test definitions in a separate annex.
  - Manufacturer-specific codes exist outside the generic list.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: this confirms our existing rule. The engine must
  never contain code definitions; they come from a sourced data layer with
  trust levels (our Phase 2B design).

## 4. Measurements and values

**F4.1 Raw values are converted to physical values with units and limits.**
- Source: [S1]; [S8].
- Evidence:
  - ODX converts raw data to physical values through per-parameter properties
    covering data type, a coded-to-physical computation method, unit and
    limits.
  - Generic OBD parameters each have a formula, unit and min/max range.
- Status: OBSERVED. Confidence: HIGH (ODX), MEDIUM (OBD detail).
- CarCode implication: a measured value is *quantity + unit + valid range*,
  and conversion is defined data. Our engine has units and conversion; v2
  should also know a quantity's **plausible range** (to reject impossible
  entries) separately from the **specification** (to judge pass or fail).

**F4.2 On-board test results carry their own limits.**
- Source: [S9] MOTOR / Underhood Service articles on OBD service $06; [S8].
- Evidence:
  - The on-board monitor test-results service reports, per test and
    component, the latest value with the manufacturer's minimum and maximum
    limits and a pass/fail outcome.
  - Test identifiers and scaling are manufacturer-defined and vary by vehicle.
- Status: OBSERVED (secondary trade sources). Confidence: MEDIUM.
- CarCode implication: a specification is a **range with a source**. Its
  meaning and scaling depend on the vehicle. That supports a
  vehicle-specific specification layer kept separate from workflows
  (recommendation R2).

**F4.3 Measurements are only valid under conditions.**
- Source: [S6]; [S2]/[S3] (OTX range concepts).
- Evidence:
  - OBD monitors only run under enable conditions defined per monitor (the
    regulation sets this structure; the conditions themselves are
    manufacturer-defined; the full text was not retrieved).
  - ASAM OTX's range extension describes values with validity ranges, limits
    and allow/deny lists.
- Status: OBSERVED that conditions exist (MEDIUM); specifics UNKNOWN.
- CarCode implication: a specification should be able to say *under what
  conditions* it applies (idle / warm engine / key on, engine off). Without
  that, the same number means different things.

## 5. Diagnostic services and routines

**F5.1 Services are request/response; jobs combine services.**
- Source: [S1]; [S5] UDS overview.
- Evidence:
  - ODX models diagnostic communication as requests and responses with
    bit-level parameters.
  - A *job* is a more complex task built from one or more services.
  - UDS defines a routine-control service to run a defined sequence in the
    control unit and return results.
- Status: OBSERVED. Confidence: HIGH (ODX), MEDIUM (UDS, from public
  overviews; standard text not consulted).
- CarCode implication: an "actuator test" or "service function" is a named
  routine with inputs, results and preconditions. CarCode does not talk to
  control units, so we only need a *description* of the routine the user (or
  their tool) runs: name, required capability, expected observation. We do
  not need the protocol.

**F5.2 Generic OBD has limited bidirectional control.**
- Source: [S8].
- Evidence: the generic services include one to control an on-board system or
  component. Beyond that, actuator control is manufacturer-specific.
- Status: OBSERVED. Confidence: MEDIUM.
- CarCode implication: "generic code reader" and "tool with bidirectional
  control" are different capabilities. Many useful tests (forcing an
  injector, commanding a fan) need the latter.

## 6. Workflow and procedure representation

**F6.1 Test sequences are an exchange format, separate from the runtime.**
- Source: [S2] ASAM OTX report; [S3] ISO 13209 summaries.
- Evidence:
  - OTX is an XML, tester-independent format for describing diagnostic test
    sequences, for exchange between suppliers, manufacturers and workshops.
  - It stresses strict separation of test logic from runtime.
  - It is strongly typed, with about 150 semantic checker rules meant to catch
    errors at design time.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: this matches our prototype's two strongest choices:
  - workflows as checked data, separate from the engine;
  - a validator that rejects bad workflows before anything runs.

  Keep both.

**F6.2 The core language looks like programming: procedures, variables, flow control, exceptions.**
- Source: [S3]; [S10] Sontheim OTX page.
- Evidence: OTX's core defines parameterised procedures, constants and
  variables, data types, arithmetic and logic, flow control (branches, loops,
  parallel execution) and exception handling. One vendor describes it as a
  sequential function chart.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: OTX is a general-purpose test language for engineers.
  CarCode's workflows are for owners and mechanics stepping through by hand.
  Variables, arithmetic and parallel execution are **not** needed. Loops and
  sub-procedures are the two parts worth considering (F7.2).

**F6.3 Extensions cover diagnostic communication and user interaction.**
- Source: [S3]; [S10].
- Evidence: ISO 13209-3 adds standard extensions with instructions and data
  types for talking to control units and for interacting with the user (HMI).
  ASAM adds further extensions (25 listed, version 3.3.0, June 2025).
- Status: OBSERVED that they exist. The exact list and semantics are UNKNOWN
  (full text not consulted).
- CarCode implication: user interaction is a separate concern from the
  sequence logic. That supports keeping our node prompts as plain content and
  leaving presentation to the page.

**F6.4 Variant management is part of the procedure model.**
- Source: [S10].
- Evidence: a vendor states OTX supports variant management directly; no
  public detail on the mechanism.
- Status: OBSERVED (claim), mechanism UNKNOWN. Confidence: LOW.
- CarCode implication: weak evidence alone. Together with F2.1 it supports
  *workflow applicability* (which vehicles a workflow is for) as data.

## 7. Branching, loops, sub-procedures

**F7.1 Branching is ordinary flow control on results.**
- Source: [S3].
- Evidence: OTX's core includes branches on conditions.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: our first-match outcomes and condition-based branch
  steps are the same idea in a simpler form. Adequate.

**F7.2 Loops and procedure calls exist in the general model.**
- Source: [S3].
- Evidence: OTX includes loops and parameterised procedure calls.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication:
  - **Loops**: our prototype forbids loops, so every run must end. The one
    real need for repetition in hand-run troubleshooting is "repeat the check
    after the repair". That is better modelled as a *bounded re-check* than as
    general loops.
  - **Sub-procedures**: reusable sub-workflows (for example "check battery
    voltage" used by several workflows) would reduce duplication. They are
    worth adding only when real content repeats.

## 8. Prerequisites and preconditions

**F8.1 Preconditions are tied to diagnostic state.**
- Source: [S1].
- Evidence: ODX defines diagnostic states and transitions, and the
  preconditions for running a service or job, as a state machine (session and
  security states).
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication:
  - The general concept is that a step may only run when certain conditions
    hold, and some steps change conditions. That applies to us in plain form:
    "engine warm", "engine off", "key on, engine off", "codes cleared".
  - Security and access states are outside CarCode's scope and must stay so.

**F8.2 Monitors have enable conditions.**
- Source: [S6].
- Evidence: OBD monitors only run under defined enabling conditions, and a
  fault is confirmed only after detection on consecutive driving cycles. The
  enable-condition text itself was not retrieved.
- Status: OBSERVED that they exist; specifics UNKNOWN. Confidence: MEDIUM.
- CarCode implication: prerequisites should be *named conditions*, reusable
  across steps (for example `engine_at_operating_temperature`), so the
  engine can know a condition is already satisfied instead of asking twice.

## 9. Session state

**F9.1 Some test results persist across power cycles.**
- Source: [S9].
- Evidence: the on-board test results are kept across ignition-off cycles
  until replaced by newer results.
- Status: OBSERVED (secondary). Confidence: MEDIUM.
- CarCode implication: evidence has *time and validity*. A reading taken
  before a repair is not evidence about the state after it. v2 evidence
  should record whether it was taken before or after a repair (or more
  generally, which phase of the session).

**F9.2 Diagnostic state is an explicit state machine in the data model.**
- Source: [S1].
- Evidence: see F8.1.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: our session is already an explicit, replayable state
  (inputs → evidence → current step). Nothing in the sources suggests a
  different approach for hand-run workflows.

## 10. Evidence

**F10.1 Diagnosis updates beliefs from observations, repairs and reconfiguration.**
- Source: [S11] Breese & Heckerman 1996; [S12] Heckerman, Breese & Rommelse
  1995.
- Evidence: decision-theoretic troubleshooting distinguishes three kinds of
  action:
  1. observe and infer;
  2. repair a component, then observe again;
  3. change the configuration (for example swap a part), then observe.

  The later two need the model to represent whether a fault persists over
  time. Their case-based system records observations, causes and *whether
  repairs succeeded*.
- Status: OBSERVED (abstract-level). Confidence: HIGH that the distinction
  exists.
- CarCode implication: this maps closely onto our needs:
  - *swap tests* are configuration changes;
  - *repair then verify* is action type 2;
  - *recording repair success* is exactly what Phase 2E's confirmed repairs
    already store.

  v2 should name these evidence kinds explicitly.

## 11. Failure and unsupported states

**F11.1 Missing data is a defined outcome, not an error.**
- Source: [S7].
- Evidence: ISO 15031-5 specifies how both the vehicle and the test equipment
  should behave when data is not available.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: "not available" must be a first-class result of a
  step, distinct from pass and fail. Our prototype has unsupported routes but
  no *inconclusive* result for checks.

**F11.2 Tool capability is discovered, not assumed.**
- Source: [S13] SAE J2534-2 catalogue page; [S14] ASAM SOVD.
- Evidence:
  - J2534-2 adds optional features beyond the baseline, including a
    mechanism to *discover the features supported*.
  - SOVD describes a self-describing diagnostic API with dynamic discovery of
    content.
- Status: OBSERVED. Confidence: HIGH (catalogue pages).
- CarCode implication: the industry treats "what can this tool and vehicle
  do?" as something queried at run time. For CarCode, the person tells us
  what they have; the engine must route around what is missing. This
  validates our capability routing and argues for a richer capability list
  (R3).

## 12. Repair verification

**F12.1 Verification is the system re-running its own test.**
- Source: [S6].
- Evidence: a permanent fault code can only be erased when the on-board
  system itself determines the malfunction is no longer present (or after
  further conditions following a clear).
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: the strongest verification is **the same test that
  found the fault, passing again under the same conditions**, not only "does
  it feel fixed?". v2's repair verification should be able to name the
  re-test (the original check, a code that must not return, a monitor that
  must complete) as well as the user's yes/no.

**F12.2 Repair success is data worth keeping.**
- Source: [S12].
- Evidence: the case-based troubleshooting system records whether repairs
  succeeded and uses resolved cases to improve.
- Status: OBSERVED (abstract). Confidence: MEDIUM.
- CarCode implication: Phase 2E already stores confirmed repairs and repairs
  that did not hold. That is the raw material for learning which tests and
  repairs work, *later*, and only with care (no public percentages; see R6).

## 13. Choosing the next test

**F13.1 Optimal test ordering is computationally hard; heuristics are standard.**
- Source: [S15] Pattipati & Alexandridis 1990.
- Evidence: constructing an optimal test sequence is NP-complete. The paper
  uses information-theoretic lower bounds with heuristic search, plus
  near-optimal variants trading optimality for speed. Later work extends this
  to unreliable tests.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: do not try to compute an optimal plan. A transparent
  heuristic is the accepted approach.

**F13.2 The best next measurement reduces uncertainty most per effort.**
- Source: [S16] de Kleer & Williams 1987; [S15].
- Evidence: model-based diagnosis proposes the measurement that most reduces
  the uncertainty (entropy) over remaining candidate diagnoses on average.
  Test sequencing literature weighs this against test cost.
- Status: OBSERVED. Confidence: HIGH (concept). The exact formulas were not
  checked against the full texts.
- CarCode implication: the *shape* of a good ranking is "how well it
  separates remaining causes" against "how costly or hard it is". Entropy
  needs probabilities, which we do not have and should not invent (R4).

**F13.3 Probability/cost ordering needs probabilities and costs that are actually known.**
- Source: [S12]; [S17] Troubleshooting Under Uncertainty (MSR-TR-94-07).
- Evidence: the decision-theoretic approach recommends repairs and
  observations from *estimated expected repair costs*. It relies on fault
  probabilities from a belief network and on cost estimates. It was applied
  to automobiles among other domains.
- Status: OBSERVED (abstract-level); the full method was not read.
  Confidence: MEDIUM.
- CarCode implication: the literature's best methods need calibrated
  probabilities and costs. CarCode has neither yet. Its confirmed-repair data
  may eventually supply frequencies, but not now. Until then an **ordinal**
  ranking (no numbers shown to users) is the honest choice.

**F13.4 Single-fault assumptions are common, and limiting.**
- Source: [S15] and follow-ups; [S16].
- Evidence:
  - Classic test sequencing assumes at most one fault at a time.
  - Model-based diagnosis was introduced specifically to handle multiple
    faults.
- Status: OBSERVED. Confidence: HIGH.
- CarCode implication: our cause elimination assumes one cause explains the
  symptom. That is fine for a first version but must be stated. The
  repair-verification "did not hold" loop is the practical safety net when
  there were two faults.

---

## Sources

| Id | Source | Kind |
| --- | --- | --- |
| S1 | [ASAM MCD-2 D (ODX) wiki](https://www.asam.net/standards/detail/mcd-2-d/wiki/); [ASAM MCD-2 D page](https://asam.net/standards/detail/mcd-2-d/) | standards body, public |
| S1b | [ISO 22901-1:2008 catalogue page](https://www.iso.org/standard/41207.html) | ISO abstract |
| S2 | [ASAM report: OTX / ISO 13209](https://report.asam.net/otx-iso-13209-open-test-sequence-exchange-format); [ASAM OTX Extensions](https://www.asam.net/standards/detail/otx-extensions/) | standards body, public |
| S3 | ISO 13209 summaries: [Sontheim OTX page](https://www.sontheim-industrie-elektronik.de/en/expertise/standards/data-description/otx-iso-13209), [IME/Actia OTX](https://www.ime-actia.de/en/?p=5131), [BSI listing, Part 1](https://knowledge.bsigroup.com/products/road-vehicles-open-test-sequence-exchange-format-otx-general-information-and-use-cases), [ISO 13209-3 catalogue](https://committee.iso.org/standard/55599.html?browse=ics) | abstracts and vendor summaries |
| S4 | [SAE J2012_201612](https://saemobilus.sae.org/content/J2012_201612); [J2012-DA digital annex](https://saemobilus.sae.org/standards/j2012da_201612-digital-annex-diagnostic-trouble-code-definitions-failure-type-byte-definitions) | SAE catalogue |
| S5 | [Unified Diagnostic Services overview](https://en.wikipedia.org/wiki/Unified_Diagnostic_Services); [IME/Actia UDS ISO 14229](https://www.ime-actia.de/en/?p=5183) | secondary |
| S6 | CARB OBD II regulation documents: [final regulation order 1968.2](https://arb.ca.gov/regact/obd02/fro1968-2.pdf), [2020 workshop presentation](https://ww2.arb.ca.gov/sites/default/files/classic/msprog/obdprog/obd_feb2020wspresentation.pdf) | regulator, public |
| S7 | [ISO 15031-5 catalogue page](https://www.iso.org/standard/50816.html) | ISO abstract |
| S8 | [OBD-II PIDs and services](https://en.wikipedia.org/wiki/OBD-II_PIDs) | secondary (community) |
| S9 | [MOTOR: Advanced Mode $06 Diagnostics](https://www.motor.com/magazine-summary/advanced-mode-06-diagnostics-march-2007/); [Underhood Service: Checking into Mode $06](https://www.underhoodservice.com/?p=39606) | trade press |
| S10 | [Sontheim: OTX know-how](https://www.sontheim-industrie-elektronik.de/en/support/knowhow/otx-standard/) | vendor |
| S11 | [Breese & Heckerman, Decision-Theoretic Troubleshooting: A Framework for Repair and Experiment (UAI 1996)](https://arxiv.org/abs/1302.3563) | peer-reviewed |
| S12 | [Heckerman, Breese & Rommelse, Decision-Theoretic Troubleshooting, CACM 38 (1995)](https://www.microsoft.com/en-us/research/publication/decision-theoretic-troubleshooting/) | peer-reviewed |
| S13 | [SAE J2534-2 Optional Pass-Thru Features](https://saemobilus.sae.org/content/J2534/2_201901) | SAE catalogue |
| S14 | [ASAM SOVD](https://www.asam.net/standards/detail/sovd/) | standards body, public |
| S15 | Pattipati & Alexandridis, Application of heuristic search and information theory to sequential fault diagnosis, IEEE Trans. SMC 20(4), 1990 ([catalogue record](https://bvbvf1.bib-bvb.de/vufind/PrimoRecord/cdi_ieee_primary_65446)) | peer-reviewed |
| S16 | [de Kleer & Williams, Diagnosing Multiple Faults, Artificial Intelligence 32 (1987)](https://www.fs.isy.liu.se/Edu/Courses/DocDiagnos/CourseMaterial/deKleer_Williams_1987.pdf) | peer-reviewed |
| S17 | [Heckerman, Breese & Rommelse, Troubleshooting Under Uncertainty, MSR-TR-94-07](https://www.microsoft.com/en-us/research/publication/troubleshooting-under-uncertainty/) | technical report |
| S18 | [NRC Fault Tree Handbook, NUREG-0492 (1981)](https://www.nrc.gov/reading-rm/doc-collections/nuregs/staff/sr0492/index) | regulator handbook |

S18 was consulted for background on structured fault reasoning (top-down
decomposition of a failure into contributing causes). No finding depends on
it alone.
