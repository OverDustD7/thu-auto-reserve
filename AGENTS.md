# Project maintenance

Read [README.md](README.md) for supported behavior, [README.zh-CN.md](README.zh-CN.md) for Chinese instructions, [DEVELOPER.md](DEVELOPER.md) for commands and session design, and [SKILL.md](SKILL.md) for agent workflows before changing the relevant branch. Preserve existing local changes and task-specific materials; documentation work does not authorize booking or release operations.

## Changes and verification

- Keep the English and Chinese READMEs consistent about installation, permissions, storage, upgrades and limitations. Use repository-relative documentation links and fictional examples; do not copy private coordination instructions into public files.
- For behavior changes, update the relevant regression cases and run `npm test` and `npm run test:python` as applicable. The current suites contain 32 Node and 19 Python tests; report the actual counts for the candidate under review. Documentation-only changes need link and factual checks, not an unchanged full test rerun.
- Run tests with synthetic credentials and mocked services in an isolated copy. Windows DPAPI cases use the current test user's operating-system service. Do not use real session folders, school accounts or reservation endpoints for offline checks. Offline success does not verify current school rules, SSO, payment or page controls.

## Credentials and reservations

- Keep tokens, cookies, storage state and imported sessions out of source, command arguments, chat, logs and release archives. Use the existing encrypted session helpers; do not fall back to plaintext when DPAPI fails. Organizer configuration is distinct from encrypted authentication state.
- Preview supported mutations by default. A real submit, lottery entry, cancellation or deletion requires authorization for its specific object and the appropriate explicit confirmation flag. Preserve the user's selected room, date, time and member identities; never guess masked identities or use duplicate members to satisfy headcount.
- Treat uncertain submissions as uncertain: retain the returned identifier and verify before retrying. Report query failures separately from empty results. SSO, captchas, payment and seat selection remain with the user as documented.

## Candidate packaging and release

- Use an explicit file allowlist: the reviewed `README.md`, `README.zh-CN.md`, `LICENSE`, `SKILL.md`, `DEVELOPER.md`, `CHANGELOG.md`, `MODIFICATION_REPORT.md`, `.gitignore`, package manifests, requirement files, and the reviewed files under `scripts/`, `references/` and `tests/`. Use the exact reviewed member manifest; do not recursively include new files just because they exist in those directories.
- This maintenance guide is source-only and is not in that candidate. If a future distribution includes it or changes any allowlisted file, update the candidate manifest and review the actual archive again.
- Exclude `.git`, dependencies, caches, bytecode, credentials, logs, `submission/`, `probes/`, `.migration/`, private handoffs and raw review evidence. Preserve their local originals; exclusion is not permission to delete them.
- Record the exact source commit plus local deltas, archive member list, size and SHA-256. Inspect the actual archive and relevant public assets/history for private identity data, local paths, credentials and metadata; record unexamined surfaces and classify third-party contacts by context without publishing matched values. A clean text scan alone is not a release approval.
- The [MIT license](LICENSE) covers the project's own code and original documentation. Preserve third-party notices and terms. Unresolved privacy risks, material coverage gaps or unclear rights to included third-party material block release clearance; independent local documentation work can continue.
- Submit the candidate and outstanding findings for independent release review. Pushes, tags, Releases, asset replacement, installation, history rewriting, credential rotation and rollback each require their specific authorization. Keep a known prior version and its verified asset identity for an authorized rollback; a local rollback must preserve unrelated work and does not cancel school reservations.
