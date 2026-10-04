# Instructor Revenue Ledger

A production-minded financial subsystem for an online-courses LMS: students prepay a subscription term, the platform recognizes instructor revenue straight-line over that term, and settles it through an unreliable external payout provider — **without ever paying twice, over-reserving, or losing money on a timeout.**

- **Source**: https://github.com/Koko7777949/Instructor-Revenue-Ledger
- **Stack**: Hono · TypeScript · Cloudflare D1 · Vitest

## Start here

| Page | What you'll learn |
|---|---|
| [Architecture](ARCHITECTURE.md) | Spec → code map, payout lifecycle, D1 locking strategy, invariants |
| [API Reference](API.md) | Every read and ops endpoint with bodies and examples |
| [Review Script](REVIEW_SCRIPT.md) | The 5-minute demo proving double-run, retry and timeout safety |
| [AI Usage](AI_USAGE.md) | Disclosure of how AI assistance was used |
