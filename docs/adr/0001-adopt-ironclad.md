# ADR-0001: Adopt Ironclad as this project's engineering discipline

- **Status:** Accepted
- **Date:** 2026-09-23
- **Packet:** P-0 (setup)
- **Deciders:** claude-apps-gateway-foundry maintainers + Ironclad council

## Context
This project is built largely through AI-assisted sessions. That makes two failure modes far more
likely than on a conventional team:

1. **Context loss.** A session ends, a window compacts, a different model or agent picks the work up.
   Anything not written to disk is gone — including *why* something was done.
2. **Drift.** Under pressure to show progress, an agent will skip a test, widen scope, guess at an
   API, or leave the record un-updated. Each step looks locally reasonable; the aggregate is a
   codebase nobody can safely change.

Convention and good intentions do not survive either. A rule that depends on the agent remembering
it is not a rule.

## Options considered
1. **Nothing formal** — rely on prompting and review. Zero setup cost; fails exactly when the
   session is long and tired, which is when it matters.
2. **Prose guidelines** (a CONTRIBUTING or AGENTS file alone) — better, but unenforced text is
   advice. Nothing detects a skipped test at 2am.
3. **Ironclad: charter + ledger + council + executable gate** — the rules are machine-checked at
   commit time and in CI, and the project's memory lives in `docs/` rather than in a chat log.

## Decision
Option 3. Specifically:

- `.ironclad/charter.json` holds this project's commands, budgets and architecture boundaries.
- `.ironclad/gate.mjs` (vendored, zero-dependency) is the **definition of done** — `--stage packet`
  must exit 0, and it runs as a pre-commit hook and in CI.
- `docs/` holds the ledger: CHARTER, ROADMAP, STATUS, UNKNOWNS, CHANGELOG, adr/.
- Work proceeds in packets through PLAN → CONTRACT → RED → GREEN → REFACTOR → COUNCIL → GATE → LOG.

## Consequences
+ Discipline survives context loss: a fresh session reads `docs/STATUS.md` and knows where it is.
+ Drift is detected by a program (skipped tests, `.only` leaks, boundary violations, secrets,
  size/debt budgets, stale ledger) rather than noticed by luck.
+ CI and the git hook enforce the same rules, so a human can't skip them either.
− Real overhead per packet: the ledger must be updated and the gate must pass.
− The gate can produce false positives; each one is fixed by a *recorded* charter exception with a
  stated reason, never by silently loosening a budget.

## How we'd know this was wrong
If the gate becomes something we routinely bypass with `--no-verify`, it is either mis-tuned or too
slow, and the honest response is to fix the checks — not to keep bypassing them. Track it: more than
a couple of bypasses in a milestone means this ADR needs revisiting.
