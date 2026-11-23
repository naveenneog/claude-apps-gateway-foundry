# ADR-0022: Novice guides use an expected-result heading

- **Status:** Accepted
- **Date:** 2026-11-23
- **Packet:** P-35
- **Deciders:** owner asked for customer setup documentation using the novice-friendly README skill

## Context

The `simple-readme` skill requires every numbered step to use a fixed bold label for its expected result. The
repository's Learn article detector treats second-person wording as editorial prose, so that label fails T-66 even
when it is only a heading. The customer needs step-by-step guides with a clear result for every action.

## Options considered
1. Keep the skill's label and accept a failing T-66. This leaves a repository test red.
2. Remove the step-result requirement from the guide. This makes the novice guide less useful.
3. Treat the exact standalone bold heading as a label, while continuing to reject the same wording in prose.

## Decision

Option 3. `editorialViolations()` ignores only the exact standalone bold heading required by the skill. The Learn
article must still state an observable result after each step. Other uses of second-person wording remain editorial
violations. The checker exception is covered by a test.

## Consequences
+ Novice guides can follow the shared skill format while keeping the repository's factual-language check.
- The exact heading is an exception in the editorial detector; other variants are not exempt.

## How we'd know this was wrong

- A guide uses the heading to hide reader-directing prose; T-66 must still flag that prose.
- A future skill changes the required label; the narrow exception can then be removed with its test.
