# Vendored Smogon damage calculator

This directory contains the `calc` package from:

- Repository: https://github.com/smogon/damage-calc
- Commit: `e7fd7e59f3eef7ea42fba3c8b83261cb4a14109d`
- License: MIT (`LICENSE`)

The source is pinned because the npm `@smogon/calc` release available when VGCHelper V0 was created did not contain the repository's Pokemon Champions generation-zero mechanics.

`calc\package.json` has packaging metadata adjusted for a precompiled local file dependency. The local `seed-description.1` patch preserves a defender terrain seed's name before consumption so the description attributes the relevant defense boost to the item. Item consumption and numerical damage mechanics are unchanged; the exported calculator version records this patch. All other calculator source is from the pinned upstream commit.

The compiled `calc\dist` package is included in Git so a fresh checkout can install the local dependency without a separate upstream build. Its ignore rules are adjusted accordingly.

The M-C update uses upstream TypeScript 4.9.5 with Node 18 types, an ES3 CommonJS target, declarations and source maps. Compile runtime sources with the upstream options, excluding `src/test`; the unchanged upstream test artifacts are retained. Do not rebuild with the application's TypeScript 5.9: its earlier function export assignments conflict with upstream's browser compatibility shim in `src/index.ts` and make `calculate` recursive.
