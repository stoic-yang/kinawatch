# Contributing

Thanks for helping improve KinaWatch.

## Before opening a change

- Keep the service local-only and the public configuration read-only by
  default.
- Do not include real local/Obsidian journal files, ActivityWatch databases,
  personal paths, credentials, or local cache files in issues, fixtures,
  commits, or logs.
- Discuss changes that alter time-accounting semantics, the journal write
  whitelist, or the ActivityWatch REST integration contract before
  implementation.

## Development workflow

1. Create a focused branch.
2. Add or update isolated tests for behavior changes.
3. Run:

   ```sh
   python3 -m unittest discover -s tests -p 'test_*.py' -v
   npm ci --prefix frontend
   npm run build --prefix frontend
   ```

4. Confirm `git diff --check` and review the staged diff for private paths or
   data.
5. Explain what changed, why it changed, and which checks passed in the pull
   request.

Live Gate 1 checks require a valid ignored local configuration. They must be
read-only and must never use real notes as write fixtures.
