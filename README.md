# pi-ask-user

`AskUserUI` — a route-resolved "ask the user" interaction for Pi. One tool and
one reusable TypeScript entry point (`askUser`).

A questionnaire is answered through one of two routes, resolved once, when the
host adapter is created:

| Route | Runs when | The user sees |
| --- | --- | --- |
| `custom` | the host is a real Pi TUI with a bound renderer | a tabbed terminal dialog: options, a pinned free-input row, and a Markdown preview |
| `native` | `ctx.hasUI` with a callable `ctx.ui.input` (TUI, RPC/ACP) | native input dialogs, one question at a time (invalid input re-prompts) |

The registered tool returns its result to the model as tool output; `askUser`
called directly resolves to the caller. The route is a property of the host, not
of a request: a `mode`/`route` value in the input is ignored and cannot influence
it.

## Install

```bash
pi install /absolute/path/to/pi-ask-user
# or, during development
pi --extension ./src/index.ts
```

Peer dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`typebox`.

## Parameters

The registered tool name is exactly **`AskUserUI`**.

| Field | Type | Notes |
| --- | --- | --- |
| `questions` | `Question[]` | 1–5 questions (required) |
| `questions[].title` | `string` | heading (required) |
| `questions[].prompt` | `string?` | extra hint under the heading |
| `questions[].kind` | `"single" \| "multi" \| "input"?` | inferred from `options` when omitted: present ⇒ `single`, absent ⇒ `input`; `multi` is explicit |
| `questions[].options` | `Option[]?` | 1–5 × `{ label, description?, preview? }`; required for `single`/`multi`, ignored for `input` |
| `questions[].default` | `string?` | makes the question skippable |
| `questions[].id` | `string?` | non-empty; generated as `q1`, `q2`, … when omitted |
| `header` | `string?` | heading above the questionnaire |
| `displayMode` | `"overlay" \| "inline"?` | custom route only; default `overlay` |
| `timeoutPerQuestionMs` | `number?` | base timeout per question; default `60000` |

These fields are the whole input contract, for the tool and for direct `askUser`
calls alike. Unknown fields, wrong types, empty ids, and over-long values are
rejected as `invalid_request`; a `single`/`multi` question without options is an
error. An explicit `kind: "input"` ignores `options` — if present they are still
validated, then dropped. Duplicate option labels are de-duplicated and reported
in `warnings`. Limits: 1–5 questions, ≤5 options each.

There is no `mode`/`route` parameter — the route is resolved by the host. A
`mode`/`route` key in the input is ignored; any other unexpected key is rejected.

```json
{
  "questions": [
    {
      "title": "Which deploy target?",
      "kind": "single",
      "options": [
        { "label": "staging", "description": "Internal smoke test" },
        { "label": "production", "description": "Customer-facing" }
      ]
    }
  ]
}
```

## Routing and capabilities

The route is resolved once, at host creation, from exactly two inputs:

1. an explicit `mode` (`custom` | `native`) — used verbatim when its
   implementation is bound; otherwise refused with `unsupported_mode`, and the
   other bound mode is **not** substituted;
2. otherwise an initialisation-time **probe**: `custom` when both can run (custom
   preferred), else the single mode that can run.

With neither available there is no route and the call is refused with
`unsupported_mode`; an invalid configured value is refused with `invalid_config`.

`askUserSupport(host)` reports whether — and how — a host can prompt, without
prompting. It is a discriminated union on `status`:

| `status` | Meaning |
| --- | --- |
| `available` | can prompt; `route` is `custom`/`native`, `source` is `configured`/`probed`, `available` lists every mode that can run |
| `configured_unavailable` | the configured mode cannot run; `configured` names it; no fallback |
| `no_available_ui` | neither a custom TUI nor native dialogs can run |
| `invalid_config` | the configured value is not a known route |

`hostCapabilities(host)` is the raw structural probe (are the implementations
callable); `askUserSupport` applies the configured route on top of it.

With `createPiHost(ctx, { mode })`, `customUI` is bound only in `tui` mode with a
callable `ctx.ui.custom()`, and `nativeDialogs` only when `ctx.hasUI` and
`ctx.ui.input` is callable (TUI, RPC). RPC reports `hasUI: true`, so a
nonresponsive client is not pre-judged: the deadline turns silence into a
`timeout`. JSON/print have no dialog-capable UI and are refused with
`unsupported_mode`.

In an extension, `registerAskUserUITool(pi, { mode })` captures the mode at
registration and builds the host once per session from the context delivered to
`pi.on("session_start", ...)`, releasing it on `session_shutdown`. A call before
the session has started fails with `not_initialized`.

## Usage

```ts
import { askUser, createPiHost, askUserSupport } from "pi-ask-user";

const host = createPiHost(ctx);
const support = askUserSupport(host);
if (support.status !== "available") {
  // every non-available state carries an actionable `reason`
  throw new Error(support.reason);
}
const result = await askUser(
  { questions: [{ title: "Deploy where?", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }] },
  { host },
);
```

A directly-called `askUser` resolves to the caller and never forwards anything to
the model by itself; only the registered tool's result is fed back to the model.
`createAskUserHost({ name, mode, customUI, nativeDialogs })` builds a host
directly from bound implementations. See [`examples/reuse.ts`](examples/reuse.ts).

## Results

```ts
type AskUserStatus = "answered" | "aborted" | "timeout" | "error";

interface AskUserResult {
  status: AskUserStatus;
  route?: "custom" | "native";      // absent when no route ran or none exists
  answers: AskUserAnswer[];         // selections (labels), optional freeText, usedDefault
  cancelledReason?: "user" | "abort";
  warnings?: string[];
  error?: { code: AskUserErrorCode; message: string };
}
```

`aborted` covers both a user dismissal and a caller abort, distinguished by
`cancelledReason`. Errors use `empty_answer`, `invalid_request`,
`custom_ui_failed`, `native_ui_failed`, `invalid_config`, `unsupported_mode`,
`not_initialized`, or `internal`. `route` is present only when a route ran — or,
for a refused explicit config, names the requested route. The tool never returns
an unanswered questionnaire as if it were the user's answer.

## Key constraints

- **The deadline is shared and owned by the core.** Per questionnaire it is
  strictly `timeoutPerQuestionMs × questionCount` (default 60 s each), clamped to
  `MAX_SAFE_TIMEOUT_MS` (2³¹−1); there is no absolute override. The deadline and
  the caller's cancellation are raced independently of the renderer, so a
  renderer that never resolves or ignores its `AbortSignal` still yields
  `timeout`/`aborted`; late results are discarded. Cancellation is checked before
  any route branch, so an already-aborted call never renders a UI.
- **A missing route is an error, not a downgrade.** JSON/print, or an explicit
  `mode` that cannot run, is refused with `unsupported_mode` and never replaced by
  another route.
- **The native route uses single-line `input`**, one question at a time (not
  `editor`, which accepts no timeout/signal). The number and an optional note
  share one box:
  `2`, `2 | note`, or free text; a number list may be comma/space/`，`/`、`
  separated (`1,3`). Out-of-range or malformed numbers re-prompt, and an empty
  box is rejected unless the question has a `default`.
- **Tool calls run sequentially** (`executionMode: "sequential"`).
- **Short terminals degrade in a defined order:** the pinned free-input row and
  the key hints survive first, down to `MIN_USABLE_ROWS` (3); 0 rows renders
  nothing. `render(width)` never exceeds the requested width or `terminal.rows`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test test/*.test.ts (Node ≥ 22.6 runs TS directly)
npm run check       # typecheck + tests
```

`@earendil-works/pi-tui` is a runtime dependency of the custom UI, and `typebox`
is a runtime dependency of the parameter schema (`src/schema.ts`). The routing,
parsing, and deadline layers are pure, non-TUI, and free of both.
