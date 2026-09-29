# pi-ask-user

`AskUserUI` — a route-forced "ask the user" interaction for Pi.

One tool and one reusable TypeScript entry point. A questionnaire is answered
through one of three routes:

| Route | When | What the user sees |
| --- | --- | --- |
| `custom` | the configured mode is `custom` **and** the host is a real Pi TUI | a tabbed terminal dialog with options, a free-input row, and a wide-screen Markdown preview column |
| `native` | the configured mode is `native` **and** the host has `ctx.hasUI` with a callable `ctx.ui.input` (TUI, RPC/ACP), or MCP elicitation | one native input dialog per question |
| `text` | the configured mode is `text` (e.g. an MCP bridge that explicitly opted in for a client without elicitation) | with a hook: appended to the final assistant output; without one (MCP): returned inline in the tool result |

**The route is forced, never detected.** It is resolved by the trusted host
adapter in this precedence order:

1. the per-call programmatic `mode` (`askUser(request, { host, mode })`) — it
   overrides everything below, including an invalid adapter configuration,
2. the programmatic `mode` option (`registerAskUserUITool(pi, { mode })`,
   `createPiHost(ctx, { mode })`, `createMCPHost({ mode })`),
3. the `PI_ASK_USER_UI_MODE` environment variable,
4. the default **`native`** (`DEFAULT_UI_MODE`) — for every adapter, MCP
   included, with no capability inference.

Nothing else influences it: model tool parameters contain no route field and a
`mode` key in the model input is ignored. A capability is still bound to the
implementation object that performs it, so a route cannot be declared without
something that actually does the work.

There is no probing and no automatic downgrade. A forced route that the
environment cannot run is an actionable **error** (`unsupported_mode`), and an
invalid configuration value is an actionable **error** (`invalid_config`) —
never a silent fallback. A route that was started stays selected even when the
user cancels, the deadline expires, or the renderer throws.

## Install

Add the package next to your Pi installation (it is a Pi package):

```bash
pi install /absolute/path/to/pi-ask-user
# or, during development
pi --extension ./src/index.ts
```

Then ask the model for something that requires a decision; it can call:

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

Peer dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`typebox`.

## Tool parameters

The registered tool name is exactly **`AskUserUI`**. Parameters:

| Field | Type | Notes |
| --- | --- | --- |
| `questions` | `Question[]` | 1–5 questions (required) |
| `questions[].title` | `string` | heading (required) |
| `questions[].prompt` | `string?` | extra hint under the heading |
| `questions[].kind` | `"single" \| "multi" \| "input"?` | inferred from `options` / `multiSelect` when omitted |
| `questions[].options` | `Option[]?` | 1–5 options; `{ label, description?, preview? }` |
| `questions[].default` | `string?` | makes the question skippable |
| `questions[].id` | `string?` | generated as `q1`, `q2`, … when omitted |
| `header` | `string?` | heading above the questionnaire |
| `displayMode` | `"overlay" \| "inline"?` | custom route only; default `overlay` |
| `timeoutPerQuestionMs` | `number?` | base timeout per question; default `60000`. The questionnaire deadline is always `base × questionCount`; there is no absolute override |

There is **no** `mode` / `route` parameter: the UI route is host configuration.
A `mode` key in the model input is ignored on purpose, so the model can never
route its own question.

Model output is normalized leniently (aliases such as `label`/`title`/`value`,
`desc`, `allowMultiple`/`multiSelect`, string-only options), so minor schema
drift does not fail the call. Limits: ≤5 questions, ≤5 options each.

### UI mode configuration

| Where | Precedence | Notes |
| --- | --- | --- |
| `askUser(request, { host, mode })` | 0 (highest) | per-call override; beats the adapter's configured mode *and* its `configError` |
| `registerAskUserUITool(pi, { mode })` / `createPiHost(ctx, { mode })` / `createMCPHost({ mode })` | 1 | values: `custom` \| `native` \| `text` |
| `PI_ASK_USER_UI_MODE` | 2 | read by the trusted host adapters (Pi and MCP); empty means unset |
| default | 3 | `native` |

An invalid value at any level yields `status: "error"` with code
`invalid_config` and a message listing the accepted values. Forcing a route the
environment cannot run yields `status: "error"` with code `unsupported_mode` and
a **host-specific** message naming the requirement — for example the default
`native` on an MCP bridge without a bound elicitation function names client
elicitation, a Pi JSON/print host names `ctx.hasUI` / `ctx.ui.input`, and
`custom` outside a real Pi TUI names `ctx.ui.custom`.

## Routes in detail

### Custom UI (`custom`)

- Up to 5 questions as tabs, plus a **Review/confirm** tab when there is more
  than one question.
- `single` / `multi` / `input` questions. Options are rendered vertically in the
  left column with their descriptions; the focused option's Markdown `preview`
  is rendered in a right column on wide terminals and stacked below on narrow
  ones. **Previews are never shown on the native or plain-text routes.**
- A free-input row is **always** present and is rendered as a **fixed, pinned
  row**: options (and the preview) scroll in the body above it, so the input
  entry point is visible no matter how long the descriptions/preview are or how
  short the terminal is. Multi-select and free text submit together; a
  single-select answer can carry supplementary text.
- Free-input text is **synchronized into the answer on every path** — selecting
  an option, switching tabs, `Ctrl+Enter`, and submitting from the review tab —
  so text typed and then navigated away from is never lost, and drafts survive
  tab switches. Editing the input clears `usedDefault` (the answer is no longer
  purely the default).
- A question with a `default` can be skipped (`s` while the options list is
  focused); on the free-input row, pressing `Enter` with an empty box also uses
  the default. A question without a default cannot be left empty.
- Keys: `Tab`/`Shift+Tab` switch questions, `↑`/`↓` move, `Space` toggles
  (multi), `Enter` selects/confirms, `Ctrl+Enter` submits, `s` uses the default,
  `Esc` cancels. Typing any printable character jumps to the free-input row, and
  `↑` from that row returns to the options. `PgUp`/`PgDn` page a long preview
  (also `Ctrl+U`/`Ctrl+D` or `[`/`]` when the input row is not focused).
- Option descriptions wrap to the option column (never hard-truncated); a long
  preview is pageable in both the wide right column and the narrow stacked view.
- Uses the Pi TUI width helpers (`visibleWidth`, `truncateToWidth`,
  `wrapTextWithAnsi`), focus/IME (`Focusable` + the input's cursor marker),
  key helpers (`matchesKey` / `Key`), a bounded viewport for small windows, and
  theme colors. `render(width)` never exceeds the requested width, and the total
  height never exceeds `terminal.rows`, including widths below 20 columns.
- **Short terminals** degrade in a defined order. The free-input row and the key
  hints have the highest row priority; the title, tabs, prompt, notice, and body
  are dropped before them. `MIN_USABLE_ROWS = 3` is the height that fits title +
  input + hints; at 2 rows the title is dropped, at 1 row only the input remains,
  and at 0 rows nothing is rendered. `Esc` always cancels and the input always
  stays operable while at least one row exists.

### Native UI (`native`)

Exactly **one** native Pi `input` dialog per question — no `select` and no
second box. The option number and the optional trailing note live in the same
box:

| Question | Accepted input |
| --- | --- |
| single | `2` · `2 \| 补充说明` · any free text |
| multi | `1,3` · `1,3 \| 补充说明` · any free text |
| input | any free text |

Rules: the left-hand side of the first `|` is classified as follows.

1. Digits and separators only (` ` `,` `，` `、`) → an option-number list; tokens
   are validated for range and count.
2. Starts with a digit run immediately followed by a list separator
   (`,` `，` `、` `.`) — e.g. `1,a`, `1.5`, `2, please` — → a **malformed**
   option-number list and is rejected, not guessed as free text.
3. Otherwise → free text, verbatim. This covers prose like `2 options please`
   (a space after the digit, not a list separator).

A missing number means free input only. Out-of-range numbers, a multi-number
answer on a single-select question, and malformed lists all re-prompt with the
reason. An empty box is rejected unless the question has a `default`. To answer
with prose that would otherwise read as a number list, write it after an empty
left side: `| 1, please explain`. No preview is shown.

### Plain text (`text`)

On the `text` route the tool returns immediately (no blocking wait) and the
questionnaire is rendered as plain text. There are two normal outcomes depending
on whether the host has a final-output hook:

- **With a hook** (`status: "deferred"`, `deferred: true`): Pi's `message_end`
  path. The extension appends the questionnaire to the **final assistant
  message**, after the model's answer is complete and before control returns to
  the caller. Nothing is ever written to stdout, so JSON/RPC streams stay valid.
- **Without a hook** (`status: "delivered"`, `deferred: false`): the normal
  outcome for hosts such as a generic MCP client. The formatted questionnaire is
  returned in `plainText` for the caller to put straight into its tool result. It
  is **not** an error and it is **not** queued, so it can never be appended twice.

In both cases the block, per question, is: a numbered title, the prompt, an input
hint (single / multi / free input), one line per option with its description, and
— always last — a free-input line. No preview is included. The question is **not
answered yet**: the user replies with an ordinary message on the next turn, the
model interprets it, no option ids are stored, and the UI is not called again.

Pi's own print/JSON/RPC modes always have the `message_end` hook, so `text`
keeps the deferred-append behavior there.

### Timeouts

One shared deadline per questionnaire, strictly `timeoutPerQuestionMs × questionCount`
(default 60 s per question). There is no absolute override, and the computed
total is clamped to `MAX_SAFE_TIMEOUT_MS` (2³¹−1) so `setTimeout` can never
overflow into an immediate timeout. Native dialogs receive only the remaining
time.

The core owns the guarantee: the deadline and the caller's cancellation are raced
**independently of the renderer**, so a renderer that never resolves or ignores
its `AbortSignal` still yields `timeout` (or `cancelled` on caller abort) — the
call never hangs. Late renderer results are discarded. A timeout never degrades
to another route. The MCP elicitation runner forwards `timeoutMs` and `signal`
when the transport can use them.

Cancellation is checked **before** any route branch, so an already-aborted call
never renders a UI and never queues a plain-text questionnaire. The abort
listeners installed on the caller's signal are removed on every settling path
(`combineSignals` returns a `LinkedSignal` with `dispose()`), so repeated calls
do not accumulate listeners.

## Host adapter API

```ts
import { askUser, hostCapabilities } from "pi-ask-user";

interface AskUserHost {
  name: string;
  mode?: "custom" | "native" | "text"; // resolved by this adapter (opt > env > native)
  configError?: { code, message };      // set when the adapter's config is invalid
  customUI?: CustomUIRenderer;          // bound ⇒ the custom route can really run
  nativeDialogs?: NativeDialogRunner;   // bound ⇒ the native route can really run
  plainText?: PlainTextOutputHook;      // available ⇒ the append hook works
}
```

`hostCapabilities(host)` derives `{ customUI, nativeDialogs }` from the presence
of callable implementations — there is no boolean you can set independently, so a
capability cannot be falsely declared. Capabilities **verify** the forced route;
they never choose it.

### Forced mode for Pi

`createPiHost(ctx, { mode, env })` resolves the route (programmatic `mode` >
`PI_ASK_USER_UI_MODE` > `native`) and binds the implementations **independently
of the selected route**, wherever they can really run — which is what makes a
per-call `askUser(request, { host, mode })` override work:

- `customUI` — bound only in `tui` mode with a callable `ctx.ui.custom()`. A
  forced `custom` anywhere else ⇒ `unsupported_mode`.
- `nativeDialogs` — bound only when `ctx.hasUI` **and** `ctx.ui.input` is
  callable (TUI and RPC). RPC reports `hasUI: true` because dialog methods exist
  on the protocol, so a client that never answers is **not** pre-judged: the
  attempt is made and the shared deadline turns silence into an actionable
  `timeout`, telling the caller to use `text` if the client is really
  nonresponsive. JSON/print have no dialog-capable UI, so the default `native`
  fails there rather than falling back.
- `plainText` — always, backed by `message_end` (the `text` route's hook).

An invalid `mode` value or an unparsable environment variable yields
`invalid_config` with the accepted values in the message — unless the call
supplies its own `mode`, which overrides even that.

### Reuse from another extension

```ts
import { askUser, createPiHost } from "pi-ask-user";

const result = await askUser(request, { host: createPiHost(ctx) });
// per-call override: highest precedence, beats the adapter's config and env:
const forced = await askUser(request, { host: createPiHost(ctx), mode: "text" });
```

`createPiHost(ctx)` resolves the mode as described above, binds the
implementations wherever they can run, and always installs the `plainText`
hook. A per-call `mode` succeeds only when a callable implementation is bound
for it; otherwise it is `unsupported_mode`. See
[`examples/reuse.ts`](examples/reuse.ts).

### MCP bridge

An MCP host cannot render Pi's TUI, so forcing `custom` there is
`unsupported_mode`. The unconfigured default is `native` — the same as every
other adapter, with no inference from whether `elicit` was supplied. A bridge
whose client does not support elicitation therefore **must opt in explicitly**
with `createMCPHost({ mode: "text" })`; with the default and no elicitation the
call fails with `unsupported_mode` instead of silently downgrading to text.
`PI_ASK_USER_UI_MODE` is honoured here too (`createMCPHost({ env })` for
injection).

A generic MCP client has **no final-output hook**, so the questionnaire is
delivered **directly in the tool result**. This is the normal outcome of the
`text` route, not an error: `askUser` returns `status: "delivered"`,
`deferred: false`, with `plainText` populated. `formatMCPDeliveredResult(result)` wraps it with a
preamble stating the user has **not** answered yet; the user replies with an
ordinary message on the next turn. Because nothing is queued, it cannot be
appended a second time.

A bridge that really owns a hook on the final assistant message implements
`MCPFinalOutputAdapter` (a `registerFinalMessageTransform` callback) and builds the
hook with `createMCPFinalOutputHook(adapter)`, which registers a transform calling
`flushAppendix`. Then `askUser` returns `status: "deferred"`, `deferred: true`, and
the questionnaire is appended after the final answer instead.
`ASKUSERUI_MCP_INPUT_SCHEMA` and `ASKUSERUI_MCP_CONTRACT` describe the tool for
registration. See [`examples/mcp-bridge.ts`](examples/mcp-bridge.ts).

## Result shape

```ts
type AskUserStatus =
  | "answered" | "cancelled" | "timeout" | "error"
  | "deferred"   // text route; a final-output hook will append it after the final answer
  | "delivered"; // text route, no hook; formatted plain text is returned for the caller

interface AskUserResult {
  status: AskUserStatus;
  route: "custom" | "native" | "text";
  answers: AskUserAnswer[];        // selections (labels), optional freeText, usedDefault
  plainText?: string;              // populated for the no-UI routes
  deferred: boolean;               // true only when an output hook accepted plainText
  cancelledReason?: "user" | "abort";
  warnings?: string[];
  error?: { code: AskUserErrorCode; message: string };
}
```

Cancel, timeout, error, and empty answers are distinct: `cancelled`
(`cancelledReason: user|abort`), `timeout`, `error` (`empty_answer`,
`invalid_request`, `custom_ui_failed`, `native_ui_failed`, `no_output_hook`,
`invalid_config`, `unsupported_mode`, `internal`). `no_output_hook` is reserved
for a **declared** hook that fails; a host that simply has no hook yields the
normal `delivered` status. Neither `deferred` nor `delivered` means the question
was answered.

For `invalid_config` no route ran at all: `route` is reported as `text` and
`plainText` is never populated, so it cannot be mistaken for a delivery.

## Limitations (stated, not hidden)

- **The route is forced by configuration, and an unsupported forced route is an
  error, not a downgrade.** The default is `native`, so a host with no
  dialog-capable UI (Pi JSON/print) or an MCP bridge without elicitation fails
  with `unsupported_mode` until the mode is set to `text`
  (`PI_ASK_USER_UI_MODE=text` or `mode: "text"`). `custom` is only a real Pi
  TUI.
- **A nonresponsive RPC/ACP client is not pre-judged.** `hasUI: true` means the
  dialog methods exist, so the native attempt is made; if the client never
  answers, the shared deadline produces an actionable `timeout` that names the
  `text` option, instead of guessing "unsupported" without proof.
- **The plain-text append needs an output hook; without one the questionnaire is
  delivered inline.** Pi provides a hook through `message_end`, which appends the
  questionnaire to the final assistant message after the model's answer. A host
  without such a hook (e.g. a generic MCP client) gets `status: "delivered"` with
  `plainText` for the caller to return in its tool result — the normal outcome of
  the `text` route, not an error. Only a **declared** hook that fails produces
  `no_output_hook`.
- **If a run ends without a final assistant text message** (for example the run
  is aborted right after the tool result), the appendix has nowhere to attach.
  It is cleared at the next user turn / session shutdown so it cannot leak into
  an unrelated run.
- **Renderers cannot hang the call.** The deadline and caller cancellation are
  raced independently of the renderer, so even a renderer that ignores its
  signal returns `timeout`/`cancelled`. Its late result is discarded.
- **The native route uses `input` (single-line), not `editor`.** Pi's `editor`
  dialog accepts no timeout/signal, which would break the shared-deadline
  guarantee.
- **Tool calls run sequentially** (`executionMode: "sequential"`), so concurrent
  AskUserUI calls cannot interleave.
- **Short terminals:** below `MIN_USABLE_ROWS` (3) the title or the key hints may
  be dropped to stay within `terminal.rows`; the free-input row survives while at
  least one row exists, and 0 rows renders nothing.
- Free text on the native route is single-line; use the custom UI for long input.
- **Native parser ambiguity rule:** prose that reads like an option-number list
  (`1,a`, `1.5`, `2, please`) is rejected as malformed rather than treated as free
  text. Write such prose after an empty left side (`| ...`).

## API surface

`askUser`, `askUserNormalized`, `createPiHost`, `createPiCustomRenderer`,
`createNativeRunner`, `createMCPHost`,
`createMCPNativeRunner`, `createMCPFinalOutputHook`, `formatMCPDeliveredResult`,
`MCP_DELIVERED_PREAMBLE`, `ASKUSERUI_MCP_CONTRACT`,
`ASKUSERUI_MCP_INPUT_SCHEMA`, `AskUserComponent`, `SPLIT_MIN_WIDTH`,
`MIN_USABLE_ROWS`, `formatPlainText`, `parseNativeAnswer`, `nativeInputHint`,
`normalizeAskUserRequest`, `AskUserUIParams`, `AskUserValidationError`,
`MAX_QUESTIONS`, `MAX_OPTIONS`, `LIMITS`, `DEFAULT_TIMEOUT_PER_QUESTION_MS`,
`hostCapabilities`, `UI_MODE_ENV_VAR`, `UI_MODES`, `DEFAULT_UI_MODE`,
`isUIMode`, `normalizeUIMode`, `resolveUIMode`, `createDeadline`, `safeTimeoutMs`,
`MAX_SAFE_TIMEOUT_MS`, `combineSignals`, `AppendixRegistry`,
`defaultAppendixRegistry`, `createPlainTextHook`, `createUnavailablePlainTextHook`,
`flushAppendix`, `finalizeAnswers`, `toAnswer`, `draftFromDefault`,
`draftIsEmpty`, `emptyDraft`, types `AskUserUIMode` / `PiHostOptions` /
`MCPHostOptions` / `MCPElicitFn` / `MCPFinalOutputAdapter` / `LinkedSignal`, and
all public types.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test test/*.test.ts (Node ≥ 22.6 runs TS directly)
npm run check       # typecheck + tests
```

`@earendil-works/pi-tui` is a runtime dependency of the custom UI; the core
routing, parsing, and formatting layers are pure and dependency-free.
