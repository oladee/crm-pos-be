# POS API

This service is installed and built with pnpm only.

- Install, add, and update dependencies with `pnpm`. Do not run `npm install` or `yarn`.
- `pnpm-lock.yaml` is the lockfile. When `package.json` changes, update it with `pnpm install` and commit the lockfile in the same change.
- Do not add or refresh `package-lock.json`. The deploy runs `pnpm install --frozen-lockfile` and fails when that lockfile is behind `package.json`.
