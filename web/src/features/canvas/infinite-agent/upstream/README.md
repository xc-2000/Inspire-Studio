# Vendored infinite-canvas API Agent

Source: <https://github.com/tigerowo/infinite-canvas>

Commit: `f4e557ebf656cafb7f6a69d1d44959a5845b1b65`

Imported on: 2026-09-30

Original source directory: `web/src/app/(user)/canvas/agent/`

License: GNU Affero General Public License, version 3.

## Imported source

The API Agent runtime, tool definitions and argument normalization, JSON fallback
parser, token estimation and checkpoint compaction, skill routing, and all 13
phase/capability skill files are copied from the pinned upstream commit.
`types.ts` extracts only the Agent protocol, state, node type, connection, and
reference types from the upstream canvas `types.ts`.

`canvas-agent-context.ts` keeps the upstream context types and JSON serializer.
The full original context builder is preserved verbatim as
`canvas-agent-context.reference.txt`; it is not executed. The host adapter builds
the context using this project's canvas node model and generation configuration.

The Codex bridge hook `use-codex-agent.ts` and server-side bridge are not imported;
this integration uses the default API Agent.

## Local changes from the pinned source

- Agent type imports point to `./types`; `AiConfig` points to the host's
  `@/features/settings/stores/use-config-store` type.
  The node type enum is represented by an equivalent constant and string union
  so native Node.js TypeScript tests can load it without enum transformation.
- Model request imports point to `../transport`, which must use the host's
  authenticated model and billing path.
- `RunCanvasAgentInput.tools` optionally restricts exposed tools to the host's
  supported adapters; without it the upstream defaults are retained.
- The local `search_skills` and `activate_skills` action names, strict argument
  normalization, and Chinese activity labels support the host skill catalogue.
  Their schemas are exported separately in `CANVAS_AGENT_SKILL_DISCOVERY_TOOLS`;
  `read_skill_file` uses `CANVAS_AGENT_SKILL_FILE_TOOL`. None are included in the
  default `CANVAS_AGENT_TOOLS`, so a host must opt in with matching executors.
- `activeSkillContents` supplies selected skill roots in full. Selected roots
  replace the built-in creative templates while keeping the shared core rules.
  Optional `getActiveSkillContents()` refreshes them on every turn and whenever
  checkpoint compaction rebuilds the prompt. Newly activated skills and their
  attachment instructions therefore enter the next model request immediately.
  A host-provided `read_skill_file` schema remains exposed before activation.
- Any action batch containing `activate_skills` or `read_skill_file` returns
  `skill_content_review_required` for canvas, media, and state writes without
  executing them, regardless of action order or skill-tool success. Read-only
  tools still run, and all tool-call receipts are retained. Writes must be
  submitted in a subsequent turn after the model receives the skill content.
- Optional `getUnreadRequiredSkillFiles()` returns the exact skill IDs and paths
  of required main-file parts that are not yet available to the model. The
  runtime snapshots them at the start of each batch and defers all writes until
  they are read, retaining read-only queries and skill tools. A premature final
  answer gets a bounded continuation with the missing paths; reaching the step
  limit reports that skill-dependent work remains incomplete. Fully inline
  skill roots require no additional file reads.
- Optional `requestTurn` and `requestCheckpoint` inputs allow offline tests and
  preserve the default transport functions for production.
- The initial protocol checkpoint is emitted before the first model request so
  an interrupted request preserves its original user message.
- `executeActions` passes `AbortSignal` to the host executor and rethrows aborted
  execution, including `AbortError`, so stopping a run cannot become another
  failed-tool model turn.

The 13 built-in skill texts, phase routing when no host skill is active,
checkpoint grouping, and native tool and JSON fallback flow otherwise retain
the upstream implementation.

## Integration interfaces

`runCanvasAgent(input)` and `createCanvasAgentState()` are exported from
`canvas-agent-runtime.ts`. The host supplies `config`, `getContext(state)`,
`executeAction(action, signal)`, optional tool/skill selections or
`getActiveSkillContents()`, `getUnreadRequiredSkillFiles()`, and checkpoint and
activity callbacks.
`executeActions` is exported for tool runner tests.

`../transport` must export:

- `CANVAS_AGENT_JSON_FALLBACK_SIGNAL`
- `canvasAgentSystemPrompt(config, prompt, jsonTools?, nativeTools?)`
- `canvasAgentTokenCalibrationKey(config)`
- `isCanvasAgentContextLimitError(error)`
- `requestCanvasAgentTurn({ config, systemPrompt, messages, tools, toolMode, signal })`
- `requestCanvasAgentCheckpoint({ config, previousCheckpoint, messages, signal })`

The turn result must include `content`, `toolCalls`, and `toolMode`; optional
`reasoningContent`, `responseItems`, and `toolError` are retained as protocol
data by the runtime. Checkpoint returns a string. The exact types are defined by
the transport implementation using the protocol types from `types.ts`.

External dependencies: host `AiConfig` type, `nanoid`, `jsonrepair`, and the
`../transport` functions above. No upstream canvas page, store, or generation
provider is required by this runtime.

## Existing studio skill library

The host `../skill-library.ts` bridges administrator-managed image, video, and
setting-graph skills to `activeSkillContents`. Up to five selected IDs are
revalidated through the authenticated enabled-skill detail endpoint on every
submission. The composer saves selection metadata with its draft and messages.

Small definitions are supplied in full. Large imported definitions retain all
embedded source text in a request-local, read-only `read_skill_file` registry;
root content and each returned part are bounded to 12,000 characters. Main files,
reference files, and part continuations are indexed explicitly. The registry has
no filesystem, shell, MCP, or CLI execution capability. Legacy CreationPlan output
instructions are adapted to the current tool protocol. The registered
`first-last-frame` workflow remains in its dedicated video creation entry point.

Skill selection is explicitly identified separately from selected canvas nodes.
This prevents models from treating an empty canvas selection as missing skills.

The host may expose the independent discovery tools to search catalogue
summaries and activate verified skill IDs during a run. `search_skills` accepts
an optional query and image/video/setting-graph filter with pages of at most 12
results. `activate_skills` requires one to five unique positive numeric IDs.
The runtime delegates catalogue access and activation to the host executor;
its dynamic getter reads the resulting request-local skill roots.

## Verification

All 13 skill files and the preserved original context source match
the pinned source byte for byte. Memory retains the upstream compaction and
token estimation. Tool schemas, normalization, parsing, skill selection, and
runtime contain the host integration changes described above.

The offline behavior tests use injected model responses and cover native
multi-step tool feedback, whole-batch argument rejection and bounded repair,
unrequested arrangement rejection, JSON fallback and truncated JSON rejection,
tool subset exposure, abort propagation, initial checkpoint preservation,
complete-round history compaction, selected skill priority, strict discovery
arguments, next-turn activation, attachment tool availability, and dynamic
skills during both estimated-budget and provider-limit checkpoint compaction.
They also cover skill activation and file-read barriers, failed activation,
receipt preservation, and normal writes after the model reviews the content.
Required-file tests cover partial main-file reads, short inline roots, read-only
queries, premature completion, and bounded continuations with missing paths.

From `web/`:

```sh
node --experimental-strip-types --loader ./scripts/node-test-loader.mjs --test src/features/canvas/infinite-agent/upstream/canvas-agent-runtime.test.ts src/features/canvas/infinite-agent/upstream/canvas-agent-tools.test.ts
```
