# Hermes Shield — action-surface report: will

## OVERALL RISK: None (no proven-live)   (OWASP Severity x Likelihood — PROVEN-LIVE only)
- **Proven-live rated** — High:0 · Med:0 · Low:0
- **⚠ 0 high-risk CANDIDATES** — unvalidated, may include false positives; need a human trace + PoC before they count. NOT a severity verdict.
- **Repo scanned:** 100.0% (220 files) · guard model: python
- **Total action-surfaces:** 0 · **vulnerable:** 0
- **Non-gated (live threat):** 0 · **Gated (protected):** 0
- **Reachable actions — review (amber):** 0 — reachable + unguarded reversible/social actions (post/reply/like); lower blast-radius than the red band.
- **Fixed-destination sends — review (amber):** 0 — reachable + unguarded messaging/external sends to a proven fixed (config/constant) destination; tainted content, not exfil, but never a clean bill.

## 🔴 PROVEN-LIVE (human-traced + PoC-confirmed): 0
Reachable + unguarded HERE now AND empirically proven — we ran the sink with a benign payload.

## 🟡 CANDIDATE-CRITICAL (scanner-flagged, UNVALIDATED): 0
Grounded-critical per the static scanner but NOT yet human/PoC-confirmed — some are false positives.
Never sent to anyone until a human traces + a PoC confirms each one.

## 🟠 INSTALL-LIABILITY (RCE-class): 0
Proven inert in THIS repo (no local entrypoint AND no untrusted ingress/unresolved dispatch reaches
them) — but a live attack surface the moment a new user installs/wires this tool into an agent that
feeds it untrusted input. The risk you INHERIT. (Sinks we could not prove inert are listed above
under REACHABILITY UNKNOWN, not here.)