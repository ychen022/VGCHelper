# Vendored Smogon damage calculator

This directory contains the `calc` package from:

- Repository: https://github.com/smogon/damage-calc
- Commit: `2c50a89d9e369289965b1448a6f5c1b7d41520c7`
- License: MIT (`LICENSE`)

The source is pinned because the npm `@smogon/calc` release available when VGCHelper V0 was created did not contain the repository's Pokemon Champions generation-zero mechanics.

`calc\package.json` has only packaging metadata adjusted for a precompiled local file dependency. Calculator source and mechanics are otherwise from the pinned upstream commit.

The compiled `calc\dist` package is included in Git so a fresh checkout can install the local dependency without a separate upstream build. Its ignore rules are adjusted accordingly.
