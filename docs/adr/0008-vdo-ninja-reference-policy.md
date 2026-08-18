# ADR 0008 — VDO.Ninja is a controlled reference, not a code source

## Status

Accepted engineering and provenance policy. Legal conclusions remain subject to qualified review.

## Context

VDO.Ninja and its WebSocket server contain valuable mature behavior for WebRTC, capture, ICE,
recovery, and signaling. Their default licensing is GNU AGPL v3, individual files may override the
default, and bundled third-party material has mixed provenance. Untracked copying could impose
obligations, lose notices, or contaminate a differently licensed project.

## Decision

Use the pinned upstream repositories to identify behaviors and test scenarios. Prefer standards,
official platform documentation, black-box observation, and independent implementation in original
structure and language. Record exact repository/SHA/path and the question researched. Do not copy
large modules, minified code, assets, translations, tests, or third-party bundles.

If material adaptation is genuinely necessary, stop for explicit licensing/legal review, isolate
the derived component for auditability, preserve notices and provenance, mark modifications, and
satisfy all applicable license obligations. Isolation improves traceability but does not itself
remove AGPL obligations.

## Consequences

- Engineers spend more time translating observed behavior into independent requirements/tests.
- Provenance is reviewable and accidental copying is less likely.
- Useful generic WebRTC concepts remain available through standards-based implementation.
- A future decision to include AGPL-derived work is visible and deliberate.

## Alternatives

- **Vendor or fork VDO.Ninja:** rejected for T0 and incompatible with the lightweight product scope.
- **Copy only small unattributed fragments:** rejected because size alone does not settle provenance
  or derivative-work questions.
- **Never inspect upstream:** rejected because disciplined reference use provides valuable failure
  and interoperability knowledge.
