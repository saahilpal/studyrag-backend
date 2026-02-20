# Security Hygiene

## Repository Secret Policy

- Do not commit `.env` or any credential-bearing variant.
- Keep runtime secrets in local environment management tooling.
- Only commit placeholders in `.env.example`.

## Local Verification Commands

```bash
git ls-files .env .env.local .env.production
git grep -n -I -E "(AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----)" $(git rev-list --all)
```

## Current Status

No committed secrets were detected during the latest repository audit.
