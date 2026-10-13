# @black942026/pi-ask-user

A Pi extension for asking structured questions through interactive terminal
or native dialogs. Supports single-choice, multiple-choice, free-text,
boolean, and flat typed form answers, with configurable timeouts and cancellation.

Install the package to add the **`ask_user`** tool to Pi. Other extensions can
reuse the same interaction through the TypeScript API.

Two entry points share one strict questionnaire contract and one route resolution:

- the registered model-facing tool **`ask_user`**;
- the host-bound TypeScript API **`createAskUser(ctx)`**, for other extensions.

A questionnaire is answered through one of two routes, resolved once when the host
is created:

| Route | Runs when | The user sees |
| --- | --- | --- |
| `custom` | the host is a real Pi TUI with a bound renderer | a tabbed terminal dialog: options, boolean controls, forms, text input, and Markdown previews |
| `native` | `ctx.hasUI` with a callable `ctx.ui.input` (TUI, RPC/ACP) | native dialogs, one logical question at a time; with `allowFreeText: false`, single/bool use `ctx.ui.select`; multi/text keep input boxes; form fields are sequential dialogs |

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
| `questions[].kind` | `"single" \| "multi" \| "input" \| "bool" \| "simple-form"?` | inferred from `options` when omitted: present ⇒ `single`, absent ⇒ `input`; other kinds are explicit |
| `questions[].options` | `Option[]?` | 1–5 × `{ label, description?, preview? }`; required for `single`/`multi`, validated then dropped for legacy `input`, rejected for `bool`/`simple-form` |
| `questions[].default` | `(string \| boolean)?` | string for legacy kinds, boolean for `bool`; `simple-form` uses field defaults |
| `questions[].fields` | `FormField[]?` | required only for `simple-form`; 1–10 flat fields, never nested |
| `fields[].name` | `string` | unique literal output key, 1–64 ASCII letters/digits/`_`/`-`, starting with a letter or `_` |
| `fields[].label` | `string` | field label (required) |
| `fields[].kind` | `"bool" \| "single" \| "multi" \| "input"` | exact non-nesting field kind |
| `fields[].required` | `boolean?` | default `false`; `false` is a valid answered boolean |
| `fields[].options` | `Option[]?` | required for field `single`/`multi`, rejected for field `bool`/`input` |
| `fields[].default` | `(boolean \| string \| string[])?` | boolean, selected label, selected-label array, or text according to field kind |
| `questions[].id` | `string?` | non-empty; generated as `q1`, `q2`, … when omitted |
| `header` | `string?` | heading above the questionnaire |
| `allowFreeText` | `boolean?` | default `true`; `false` removes supplemental/free-text answers on single/multi questions; native single/bool (including form fields) use selectors while multi/text keep input boxes |
| `displayMode` | `"overlay" \| "inline"?` | custom route only; default `overlay`; a user-configured preference overrides it |
| `timeoutPerQuestionMs` | `number?` | base timeout per question; default `60000`; a user-configured preference overrides it |

These fields are the whole input contract, for the tool and for direct calls
alike. Unknown fields, wrong types, empty ids, and over-long values are rejected
as `invalid_request`; a `single`/`multi` question or field without options is an
error. An explicit legacy `kind: "input"` keeps its existing behavior: supplied
options are validated, then dropped. Duplicate option labels are de-duplicated
and reported in `warnings`.

### Disable supplemental text

Set top-level `allowFreeText: false` to hide the custom UI's bottom extra input
on single/multi questions and require option selections. Regular `input`
questions and form text fields remain editable. Choice defaults must match an
option label when supplemental text is disabled.

```json
{
  "allowFreeText": false,
  "questions": [
    { "title": "Environment", "kind": "single", "options": [{ "label": "dev" }, { "label": "prod" }] }
  ]
}
```

On the native route with this flag:

- Single-choice questions/fields use `ctx.ui.select`, returning option labels.
- Boolean questions/fields use a True/False selector. We deliberately avoid
  `ctx.ui.confirm`: Pi returns `false` both for a negative answer and dismissal,
  so a selector is necessary to preserve cancellation semantics.
- Multi-choice questions/fields **still use a text box**, accepting numbers such
  as `1,3`; standalone multi questions reject prose and `| note`.
- Text questions/fields keep their text boxes.
- Selectors provide explicit default/skip actions where applicable. A host
  without `ui.select` refuses requests that need it rather than falling back
  to text input. The shared deadline and abort signal apply to every dialog.

Omitting the flag (or setting `true`) preserves the native input-box behavior.

Forms are flat. Field names cannot contain dots, brackets, spaces, or path-like
syntax, and `__proto__`, `constructor`, and `prototype` are rejected. Names must
be unique. Defaults are checked against the field kind and, for choice fields,
against the option labels. A top-level form `options` or `default`, a nested
form/schema, and `options` on a boolean are errors. Limits are `MAX_QUESTIONS=5`,
`MAX_OPTIONS=5`, and `MAX_FORM_FIELDS=10`.

```json
{
  "header": "Release",
  "questions": [
    {
      "title": "Proceed with deployment?",
      "kind": "bool",
      "default": false
    },
    {
      "title": "Deployment settings",
      "kind": "simple-form",
      "fields": [
        { "name": "confirmed", "label": "Confirm", "kind": "bool", "required": true },
        {
          "name": "target",
          "label": "Target",
          "kind": "single",
          "required": true,
          "options": [
            { "label": "staging", "description": "Internal smoke test" },
            { "label": "production", "description": "Customer-facing" }
          ]
        },
        {
          "name": "checks",
          "label": "Checks",
          "kind": "multi",
          "options": [{ "label": "unit" }, { "label": "integration" }],
          "default": ["unit"]
        },
        { "name": "note", "label": "Release note", "kind": "input" }
      ]
    }
  ]
}
```

## User config file

There are **no AskUser-specific environment-variable preferences**. User
preferences live in a JSON file alongside Pi's `settings.json`:

```
~/.pi/agent/ask-user.json
```

The directory is resolved by Pi's `getAgentDir()`. If you set Pi's
`PI_CODING_AGENT_DIR`, the file is `<PI_CODING_AGENT_DIR>/ask-user.json` instead.
The old `~/.pi/ask-user/config.json` location is no longer read; move an existing
file to the new location (without overwriting a config already there), then
restart Pi or run `/reload`.

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
`ctrl+n`, `ctrl+enter`, `alt+q`) are each rejected with a specific reason. A key
is never silently substituted.

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

## Cancel countdown shortcut

In the **custom terminal UI** (overlay or inline), press **`Alt+Q`** to cancel
this questionnaire's countdown without dismissing it or changing your answers.
The header shows **`No timeout`**; you can keep answering, submit normally, or
press `Esc` to dismiss. Caller aborts still work. This is a one-way change for
the current questionnaire only; the next call starts with its configured timeout.
An already-expired deadline cannot be cancelled.

The key is shown in the bottom hints and reserved against `overlayToggleKey`
conflicts. Native input dialogs do not support this shortcut. If an overlay is
hidden, restore it first with its show/hide key before pressing `Alt+Q`.

## Questionnaire keyboard controls

In the custom terminal UI, all question kinds share the same controls:

- `Tab` / `Shift+Tab` switches question/review tabs, including from forms.
- Up/down moves control focus backward/forward. Left/right does the same
  outside text inputs; inside text inputs it moves the text cursor instead.
  Arrows never change values or selections. A standalone boolean has only one
  focus target, so arrows leave it unchanged.
- `Space` toggles booleans/multiple-choice selections or selects the focused
  single-choice option. In a text input, Space inserts a space.
- `Enter` selects the focused single-choice option or toggles the boolean,
  then continues to the next question (or submits a one-question questionnaire).
  On multiple-choice options it only toggles, keeping focus in place. In text
  inputs and on Continue/Submit buttons, it confirms/continues.
- `Ctrl+Enter` validates and submits the whole questionnaire without changing
  the focused control. Required unanswered questions block submission; defaults
  can still be used.

A standalone `bool` shows **one** control: `[✓] True` or `[✗] False`.
An unset boolean shows `[ ] True (unset)` and becomes true when Enter or Space
is pressed. Defaults are displayed immediately; Enter toggles and continues,
Space only toggles, while Ctrl+Enter submits them unchanged. `false` is an
answered value, never an empty answer.

A `simple-form` is one question tab with all fields in one scrollable view:

- Up/down moves through fields, choice options, and the Continue/Submit button.
  Left/right also navigates outside text inputs; inside text inputs it moves
  the text cursor. Moving beyond a field's first/last option focuses the adjacent
  field/button. Focus stops at the beginning/end of the form.
- `Tab` / `Shift+Tab` switches question/review tabs, preserving field focus and values.
  `Ctrl+Left` / `Ctrl+Right` remains an alternate question-tab shortcut.
- `Enter` toggles boolean fields or selects single-choice options, then moves
  to the next field or Continue/Submit button. `Space` changes the value without
  moving focus. For multi fields, both keys only toggle; use arrows to move on.
  Text fields also use `Enter` to move on. Optional unset fields remain omitted.
- `Ctrl+Enter` validates and submits the questionnaire. Required missing/empty
  fields focus the first invalid field. `PageUp` / `PageDown` scrolls long form
  or preview content.
- `Esc`, `Alt+Q`, and overlay show/hide keep their existing behavior.

The active form field's input or selected option is automatically scrolled into view. Rendering is bounded
by both terminal width and rows, including narrow/short terminals. Focus is
propagated to Pi's `Input`, so the hardware cursor marker remains available to
Chinese/Japanese/Korean IMEs. Inside text fields, Left/Right moves the text
cursor, as do `Ctrl+B` / `Ctrl+F` and `Home` / `End`; Up/Down changes control focus.
Native dialogs are host-owned and use the host's keyboard controls; this custom
terminal key mapping does not override native TUI/RPC/ACP dialogs.

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

interface AskUserAnswer {
  index: number;
  id: string;
  title: string;
  kind: "single" | "multi" | "input" | "bool" | "simple-form";
  selections: string[];            // unchanged for legacy kinds
  freeText?: string;               // unchanged for legacy kinds
  usedDefault: boolean;
  value?: boolean | Record<string, boolean | string | string[]>;
}
```

`bool` answers use `value: boolean`, including meaningful `value: false`.
`simple-form` answers use a flat object keyed by field `name`. Choice values are
option labels, multi-choice values are label arrays, boolean values stay
booleans, and entered text is trimmed on both routes. Optional fields left
unset are omitted. An explicit field default is included and makes `usedDefault` true; required empty
text/multi fields are still invalid.

`aborted` covers both a user dismissal and a caller abort, distinguished by
`cancelledReason`. Errors use `empty_answer`, `invalid_request`,
`custom_ui_failed`, `native_ui_failed`, `invalid_config`, `unsupported_mode`,
`not_initialized`, or `internal`. `route` is present only when a route ran — or,
for a refused explicit config, names the requested route.

## Key constraints

- **The deadline is shared and owned by the core.** Per questionnaire it is
  initially `timeoutPerQuestionMs × questionCount` (default 60 s each), clamped to
  `MAX_SAFE_TIMEOUT_MS` (2³¹−1); there is no absolute override. The deadline and
  the caller's cancellation are raced independently of the renderer, so a renderer
  that never resolves or ignores its `AbortSignal` still yields
  `timeout`/`aborted`, unless the user explicitly cancels the timeout with `Alt+Q`
  in the custom UI (caller aborts remain effective); late results are discarded.
  Cancellation is checked before any route branch, so an already-aborted call
  never renders a UI.
- **A missing route is an error, not a downgrade.** JSON/print, or an explicit
  `mode` that cannot run, is refused with `unsupported_mode` and never replaced by
  another route.
- **Preferences are configured in a file, not environment variables.**
  `<Pi agent directory>/ask-user.json` (normally `~/.pi/agent/ask-user.json`) is
  read once per host/session and strictly validated. Only the directory follows
  Pi's `PI_CODING_AGENT_DIR`. An invalid config is `invalid_config`, never a fallback.
- **Events never leak content by default.** `herdr:blocked` bounds a real wait
  exactly once on each side; outcome events are one per UI attempt and carry only
  correlation id, route, and status.
- **The overlay toggle is overlay-only.** Inline and native register no raw
  input listener; hiding never pauses the deadline.
- **The native route defaults to single-line `input`**, one logical question at a time (not
  `editor`, which accepts no timeout/signal). The number and an optional note
  share one box: `2`, `2 | note`, or free text; a number list may be
  comma/space/`，`/`、` separated (`1,3`). Out-of-range or malformed numbers
  re-prompt, and an empty box is rejected unless the question has a `default`.
  A form opens sequential per-field dialogs under the same questionnaire
  deadline: boolean fields accept `true`/`false`, form choices accept only
  option numbers and return labels, and optional empty fields are omitted (or
  use their field default). With `allowFreeText: false`, single/bool use native
  selectors (including form fields); multi stays a numbers-only text box, and
  text fields stay editable. Cancel/abort/timeout at any field terminates the form.
- **Tool calls run sequentially** (`executionMode: "sequential"`).
- **Short terminals degrade in a defined order:** when enabled, the pinned legacy free-input row and
  the key hints survive first, down to `MIN_USABLE_ROWS` (3); 0 rows renders
  nothing. Bool, forms, and choices without supplemental text reserve a visible
  row for the focused control and auto-scroll it.
  `render(width)` never exceeds the requested width or `terminal.rows`.

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

For maintainer release instructions, see
[CONTRIBUTING.md](https://github.com/black-94/pi-ask-user/blob/main/CONTRIBUTING.md#release).
