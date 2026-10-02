# @black942026/pi-ask-user

A Pi extension for asking structured questions through interactive terminal
or native input dialogs. Supports single-choice, multiple-choice, and free-text
answers, with configurable timeouts and cancellation.

Install the package to add the **`ask_user`** tool to Pi. Other extensions can
reuse the same interaction through the TypeScript API.

Two entry points share one strict questionnaire contract and one route resolution:

- the registered model-facing tool **`ask_user`**;
- the host-bound TypeScript API **`createAskUser(ctx)`**, for other extensions.

A questionnaire is answered through one of two routes, resolved once when the host
is created:

| Route | Runs when | The user sees |
| --- | --- | --- |
| `custom` | the host is a real Pi TUI with a bound renderer | a tabbed terminal dialog: options, a pinned free-input row, and a Markdown preview |
| `native` | `ctx.hasUI` with a callable `ctx.ui.input` (TUI, RPC/ACP) | native input dialogs, one question at a time (invalid input re-prompts) |

Only these two routes exist, and the route belongs to the host: it is configured
or probed when the host is created, never per request.

## Install

```bash
pi install npm:@black942026/pi-ask-user
```

Start a new Pi session, or run `/reload` in an existing session, to load the
extension. The `ask_user` tool is registered automatically.

Requires Node.js ≥ 22.19.0 and Pi ≥ 0.87.0. Pi supplies the host dependencies
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`;
no separate dependency installation is needed when using `pi install`.

## Tool parameters

The registered tool name is exactly **`ask_user`**.

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
| `displayMode` | `"overlay" \| "inline"?` | custom route only; default `overlay`; a user-configured preference overrides it |
| `timeoutPerQuestionMs` | `number?` | base timeout per question; default `60000`; a user-configured preference overrides it |

These fields are the whole input contract, for the tool and for direct calls
alike. Unknown fields, wrong types, empty ids, and over-long values are rejected
as `invalid_request`; a `single`/`multi` question without options is an error. An
explicit `kind: "input"` ignores `options` — if present they are still validated,
then dropped. Duplicate option labels are de-duplicated and reported in
`warnings`. Limits: 1–5 questions, ≤5 options each.

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

## User config file

There are **no environment variables**. User preferences live in a documented
JSON file:

```
~/.pi/ask-user/config.json
```

No file — or an empty/whitespace-only file — means the built-in defaults. The
knobs are:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `"custom" \| "native"` | omitted ⇒ probe | force the UI route |
| `displayMode` | `"overlay" \| "inline"` | `overlay` | custom-UI presentation |
| `overlayToggleKey` | KeyId chord, or `null`/`"off"`/`"none"`/`"disabled"` | `alt+o` | overlay show/hide key; the disable values turn it off |
| `timeoutPerQuestionMs` | non-negative number | `60000` | base timeout per question |

```json
{
  "mode": "custom",
  "displayMode": "overlay",
  "overlayToggleKey": "alt+o",
  "timeoutPerQuestionMs": 60000
}
```

Validation is strict and actionable. Invalid JSON, an unknown key, a wrong type,
or an out-of-range value is reported as `invalid_config` naming the file and the
offending field — never ignored, coerced, or fallen back from. A bad config
makes the host unusable: every `ask_user` call is refused with the actionable
reason, and the model is told to ask in ordinary text instead.

`overlayToggleKey` is validated against the supported **KeyId** grammar and
against the questionnaire's own controls. A malformed spec (`alt+banana`), a
reserved key (`escape`/`esc` — which must keep cancelling — plus
`enter`/`tab`/arrows/`space`/`pageUp`/…), a bare printable key that would swallow
typing (`o`), and conflicting chords (`ctrl+c`, `ctrl+d`, `ctrl+u`, `ctrl+p`,
`ctrl+n`, `ctrl+enter`) are each rejected with a specific reason. A key is never
silently substituted.

### Effective precedence and read timing

Per knob:

```
explicit programmatic option  >  user config file  >  built-in default
```

and, for the two request-overridable knobs only:

```
user displayMode / timeoutPerQuestionMs  >  the model's request value  >  built-in default
```

So a user who configures `displayMode` or `timeoutPerQuestionMs` always wins over
whatever the model sends; when the user configured nothing, the model's value
applies; when neither is set, the built-in default applies.

Timing: the config file is read **once per host/session creation**, never per
request. For the registered tool the host is built in `session_start`, so the
route and preferences are fixed for the session; a reload
(`session_shutdown` + `session_start`) re-reads. `createPiHost` / `createAskUser`
read once at construction. Route resolution and preference resolution happen
once, together, and are then immutable.

Programmatic options are accepted by all three entry points:
`registerAskUser(pi, { mode, displayMode, overlayToggleKey, timeoutPerQuestionMs, configFile })`,
`createPiHost(ctx, { ... })`, and `createAskUser(ctx, { ... })`. `configFile`
may point at another path, or be `false` to skip the file (used by embedding and
by this repo's tests). `overlayToggleKey: null` disables the toggle explicitly.

## Routing and capabilities

The route is resolved once, at host creation, from exactly two inputs:

1. an explicit `mode` (`custom` | `native`) — used verbatim when its
   implementation is bound; otherwise refused with `unsupported_mode`, and the
   other bound mode is **not** substituted;
2. otherwise an initialisation-time **probe**: `custom` when both can run (custom
   preferred), else the single mode that can run.

With neither available there is no route and the call is refused with
`unsupported_mode`; an invalid configured value is refused with `invalid_config`.
A render failure never silently switches `custom` → `native`: it is reported as
`custom_ui_failed`/`native_ui_failed`.

`askUserSupport(host)` reports whether — and how — a host can prompt, without
prompting. It is a discriminated union on `status`:

| `status` | Meaning |
| --- | --- |
| `available` | can prompt; `route` is `custom`/`native`, `source` is `configured`/`probed`, `available` lists every mode that can run |
| `configured_unavailable` | the configured mode cannot run; `configured` names it; no fallback |
| `no_available_ui` | neither a custom TUI nor native dialogs can run |
| `invalid_config` | the configured value is not a known route |

With `createPiHost(ctx, { mode })`, `customUI` is bound only in `tui` mode with a
callable `ctx.ui.custom()`, and `nativeDialogs` only when `ctx.hasUI` and
`ctx.ui.input` is callable (TUI, RPC). RPC reports `hasUI: true`, so a
nonresponsive client is not pre-judged: the deadline turns silence into a
`timeout`. JSON/print have no dialog-capable UI and are refused with
`unsupported_mode`.

In an extension, `registerAskUser(pi, { mode })` captures the mode at registration
and builds the host once per session from the context delivered to
`pi.on("session_start", ...)`, releasing it on `session_shutdown`. A call before
the session has started fails with `not_initialized`.

## Direct API

For another extension that wants to ask without going through the model, bind the
interaction to its host and check availability first:

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAskUser } from "@black942026/pi-ask-user";

async function askWhereToDeploy(ctx: ExtensionContext) {
  const ask = createAskUser(ctx); // or createAskUser(host), or { mode }
  if (!ask.isAvailable) {
    // ask.notAvailableReason explains why, before any UI is shown
    throw new Error(ask.notAvailableReason ?? "no interactive UI available");
  }

  const result = await ask({
    questions: [{ title: "Deploy where?", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
  });
  // result.status === "answered" | "aborted" | "timeout" | "error"
  return result;
}
```

`createAskUser` returns a callable object:

- `ask(request)` → `Promise<AskUserResult>`; it never throws for a bad request or
  an unavailable host, and it never forwards anything to the model — a direct call
  belongs to the caller, with no plain-text fallback.
- `ask.isAvailable` → `true` when the bound host has a ready interactive route
  (its structural/configured capability, not a promise that a render will succeed).
- `ask.notAvailableReason` → the reason string when it has none, `undefined` when
  it has one.
- `ask.host` → the bound `AskUserHost`.

It accepts a Pi `ExtensionContext` (with optional options) and probes once,
reading the user config file once at the same time, or a pre-built
`AskUserHost` to reuse one. Availability reflects that host's structural +
configured state. Pass `events` to observe the interactive wait; a direct call
otherwise emits no runtime events (there is no fabricated bus).

## Tool result and model fallback

The tool returns its result to the model as tool output. Its text depends on the
outcome, and it always tells the model **not to invent an answer**:

- `answered` — the answers.
- `aborted` / `timeout` — no answer; reported plainly, with no instruction to
  re-ask in text (the UI may already have been shown, so a text re-ask would
  prompt the user twice).
- Interactive UI failed — `unsupported_mode`, `invalid_config`, `not_initialized`,
  `custom_ui_failed`, `native_ui_failed`: the UI could not complete the request, so
  the text advises the model to **ask the user the question itself in ordinary
  text**, including the question and options.
- Invalid questionnaire — `invalid_request`: a request error, **not** a UI failure;
  the model is told to fix the call. Other errors (`empty_answer`, `internal`) are
  reported plainly with no retry instruction.

The ordinary-text advice is tool output only. It is not a route, not an answer,
and no questionnaire is handed back as if the user had answered it.

## Runtime events

Pi already emits generic `ui_prompt_start` / `ui_prompt_end` around a blocking
extension UI, but they carry no result semantics. The tool adds result-bearing
events on `pi.events` (default payloads never include the question, the answers,
or free text):

| Event | When | Payload (default) |
| --- | --- | --- |
| `herdr:blocked` | entering the interactive wait | `{ active: true, label: "Waiting for user response", callId? }` |
| `herdr:blocked` | the wait terminated, once, for every outcome | `{ active: false, callId? }` |
| `ask:answered` | the user answered | `{ callId?, route, status: "answered" }` |
| `ask:aborted` | dismissed or caller-aborted | `{ callId?, route, status: "aborted", cancelledReason: "user" \| "abort" }` |
| `ask:timeout` | the shared deadline expired | `{ callId?, route, status: "timeout" }` |
| `ask:error` | the renderer failed / the UI could not finish | `{ callId?, route?, status: "error", errorCode }` |

Guarantees:

- `herdr:blocked` `{ active: true }` is emitted **only when the tool actually
  enters the interactive wait**, and is always followed by exactly one matching
  `{ active: false }`, including abort, timeout, and error.
- Invalid (`invalid_request`) and unavailable/refused requests emit **nothing**:
  no UI is attempted, so neither a blocked pair nor an outcome event is sent.
- Each outcome event is emitted **exactly once per UI attempt** and carries the
  correlation id (the tool call id, when available) plus route/status.
- The full question, answers, and free text are never broadcast by default.

A direct `createAskUser` caller has no Pi event bus. Instead of faking one, pass
an optional sink — `createAskUser(ctx, { events: { waitStarted, waitEnded } })`,
or `createAskUser(host, { events })` — or accept that no runtime events are
emitted. `AskUserEventSink` is exported for this.

## Overlay show/hide key

On the **custom overlay route only** (never inline, never native), the overlay
can be hidden and restored with the same key:

- default `alt+o`; configurable via `overlayToggleKey` and disableable with
  `null` / `"off"` / `"none"` / `"disabled"`; reserved/conflicting keys are
  rejected by config validation (see above) so `Esc` always keeps cancelling;
- implemented with `ctx.ui.custom(..., { onHandle })` →
  `OverlayHandle.setHidden()`, plus a raw `ctx.ui.onTerminalInput` listener so the
  **same** key restores the overlay even while hidden (a hidden overlay receives
  no component input);
- the toggle key is consumed; Kitty press/repeat/release events are handled so a
  single physical press cannot hide and immediately re-show it;
- the first hide shows a one-time discoverable restore notice
  (`ask_user hidden — press <key> to reopen`);
- cleanup is idempotent and **does not depend on `ui.custom()` resolving**. The
  core settles a timeout/abort independently, so the renderer listens to the
  interaction signal and removes the raw listener, drops the handle, and aborts
  the component immediately; the same cleanup also runs from `finally`. A
  renderer that ignores its signal and never resolves therefore cannot keep
  capturing keys or leave UI side effects after termination;
- hiding neither resolves the interaction nor pauses its deadline — aborts and
  timeouts still complete while hidden — and `Esc` still cancels;
- inline display and the native route register no listener at all.

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
for a refused explicit config, names the requested route.

## Key constraints

- **The deadline is shared and owned by the core.** Per questionnaire it is
  strictly `timeoutPerQuestionMs × questionCount` (default 60 s each), clamped to
  `MAX_SAFE_TIMEOUT_MS` (2³¹−1); there is no absolute override. The deadline and
  the caller's cancellation are raced independently of the renderer, so a renderer
  that never resolves or ignores its `AbortSignal` still yields
  `timeout`/`aborted`; late results are discarded. Cancellation is checked before
  any route branch, so an already-aborted call never renders a UI.
- **A missing route is an error, not a downgrade.** JSON/print, or an explicit
  `mode` that cannot run, is refused with `unsupported_mode` and never replaced by
  another route.
- **Configuration is a file, never the environment.** No `process.env` knob
  exists; `~/.pi/ask-user/config.json` is read once per host/session and
  strictly validated. An invalid config is `invalid_config`, never a fallback.
- **Events never leak content by default.** `herdr:blocked` bounds a real wait
  exactly once on each side; outcome events are one per UI attempt and carry only
  correlation id, route, and status.
- **The overlay toggle is overlay-only.** Inline and native register no raw
  input listener; hiding never pauses the deadline.
- **The native route uses single-line `input`**, one question at a time (not
  `editor`, which accepts no timeout/signal). The number and an optional note
  share one box: `2`, `2 | note`, or free text; a number list may be
  comma/space/`，`/`、` separated (`1,3`). Out-of-range or malformed numbers
  re-prompt, and an empty box is rejected unless the question has a `default`.
- **Tool calls run sequentially** (`executionMode: "sequential"`).
- **Short terminals degrade in a defined order:** the pinned free-input row and
  the key hints survive first, down to `MIN_USABLE_ROWS` (3); 0 rows renders
  nothing. `render(width)` never exceeds the requested width or `terminal.rows`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test test/*.test.ts
npm run check       # typecheck + tests

# Load a local checkout for development
pi --extension ./index.ts
# Or install it as a local package
pi install /absolute/path/to/pi-ask-user
```

`@earendil-works/pi-tui` and `typebox` are host-provided peer dependencies used
by the custom UI and parameter schema (`src/schema.ts`). They are also declared
as development dependencies for local checks. The routing, parsing, and deadline
layers are pure, non-TUI, and free of both.
