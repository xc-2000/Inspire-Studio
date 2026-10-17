# TapCanvas film production modules

Upstream: https://github.com/anymouschina/TapCanvas
Revision: `a88ef8716780ccd70390237af85d71f9ca877c1e` (2026-10-08 retrieval).
License: MIT, copyright (c) 2025 Beq; see LICENSE.

The files in this directory are copied verbatim from upstream `packages/schemas/`:

- `clip-production-packet/timeline.*`: structured shot compilation, ordered story coverage, exact-once dialogue rendering; includes upstream tests and declaration dependency `index.d.mts`.
- `video-authoring-stages/beat-structure.*`: beat structure and state transition validation.
- `narrative-audio-contract/index.*`: dialogue identity validation.

Host integration lives in `../film-story-plan.ts` and `../film-workflow.ts`. It adapts the upstream production stages (story plan → shared assets → clip design → media → ordered composition) to Inspire Studio's React canvas, Java API, model channels and R2. TapCanvas's full Hono/Prisma workflow runtime is not embedded. The separate upstream v1 fixed-character splitter is not used. No provider, story, clip count or clip duration is hard-coded by this integration.
