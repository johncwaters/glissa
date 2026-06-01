# Flaky And Known

<!-- GLISSA:NEEDS-INPUT: replace everything below with this repo's flaky/known list and re-run policy, then save. -->

Tell the team which failures are NOT regressions to chase, and how to decide a failure is flaky. The triager
classifies against this file and the auditor honors it. Useful things to include:

- KNOWN-FLAKY tests tests that fail intermittently for non-bug reasons, so the triager does not chase them.
- KNOWN-RED-ON-BASE tests tests already failing before this run; they are not regressions this run must fix.
- ENVIRONMENT / SERVICE requirements what the suite needs to run (a database, a service, a binary, network),
  and what counts as an ENV failure so the triager classifies env correctly instead of trying to "fix" it.
- RE-RUN POLICY (mandatory to fill): the explicit number of times N a suspected-flaky failure must be re-run
  and survive before it may be accepted as flaky. The auditor is required to honor this N and will not declare
  a failure flaky on a single pass. Leaving this unfilled keeps the GLISSA:NEEDS-INPUT marker and halts the
  first run, which is intended: a flaky policy must be a deliberate project choice, not an engine default.
