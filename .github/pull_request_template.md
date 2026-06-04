<!-- Thanks for contributing! Please fill out the sections below. -->

## Summary

What does this PR do and why?

## Related issue

Closes #___ <!-- or "N/A" -->

## Type of change

- [ ] Bug fix
- [ ] New tool / feature
- [ ] Refactor (no behavior change)
- [ ] Docs / tooling / CI
- [ ] Other (describe)

## Checklist

- [ ] `npm test` passes (build + unit + integration)
- [ ] Added or updated tests for the change
- [ ] New/changed tools follow the conventions in [CONTRIBUTING.md](../CONTRIBUTING.md): `heap_*` snake_case names, `.strict()` Zod schemas with `.describe()`, `Args:`/`Returns:`/`Example:` in the description, and correct `readOnlyHint`/`destructiveHint`/`idempotentHint` annotations
- [ ] Shared logic lives in `services/`; validation lives in `schemas.ts`; tools stay thin
- [ ] No secrets, tokens, or real user PII in code, tests, logs, or this PR
- [ ] Updated the README / docs if behavior or configuration changed

## Notes for reviewers

Anything reviewers should focus on, plus before/after notes where relevant.
