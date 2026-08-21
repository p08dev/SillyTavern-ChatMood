# ChatMood

A persistent, per-chat emotional state tracker for SillyTavern's main chat.
The character's mood evolves from the conversation and feeds back into the
prompt, so their tone shifts with how the conversation has actually gone.

<img width="300" height="431" alt="638688698-db66ec9b-850c-4f46-bb70-6b7f3cd68fe2(1)" src="https://github.com/user-attachments/assets/123ffa23-b436-4c57-af3c-ce795815c5b2" />


## Features

- 9-axis Plutchik mood (love, joy, trust, fear, surprise, sadness, disgust,
  anger, anticipation), stored per chat — a new chat with the same character
  starts fresh.
- Group chat support — each member's mood is tracked independently (see
  below).
- Draggable floating badge showing the dominant emotion; click for a
  breakdown popup (also draggable). Optionally switch to a static badge/
  popup pinned above the chat box instead.
- Delta burst animation showing what just changed, above the message input
  — fires for your own message as well as the character's reply, not just
  the reply.
- Edit mode — drag the bars or type exact values to set mood by hand.
- Per-chat enable/disable toggle, plus a global default for new chats.
- Configurable weighting for how much the user's message vs. the
  character's reply influences the mood.
- Reset mood to baseline (current chat only).
- Switchable keyword-matching language (English or German), including
  matching negation/intensity words in that language — takes effect after
  reloading SillyTavern.
- Character-card personality inference (MBTI temperament + archetype bias)
  checks English, German, or both — independent of the keyword-matching
  language, since a character card's language doesn't have to match it.
- Token saver mode — drops the temperament line from the injected prompt,
  the single most expensive part of it.
- Track-only mode — keeps mood tracking, the badge, and the popup working
  as normal, but stops the `<emotional_state>` block from being sent to the
  model at all, for anyone who wants the tracker without it influencing
  replies.
- Mood gently regresses toward the character's own drifted baseline every
  exchange, and a single message can't swing a value past a fixed cap, so
  values can't get permanently stuck at 0%/100% the way they could early
  on. Optionally (off by default) also drifts back over real elapsed days
  between messages.
- i18n (German) for the UI — the LLM prompt itself always stays in English
  regardless of UI language (see below).

## How it works

Mood is scored with word-boundary keyword matching (`lib/emotions.json` or
`lib/emotions-de.json`, depending on the keyword-language setting),
with negation detection and a caps/punctuation/intensity-word multiplier.
By default the character's own reply is weighted higher than the user's
message — it's the more direct signal of the character's felt reaction, the
user's message is the stimulus that provoked it. Both weights are
configurable in the settings panel.

A single message can't move an axis by more than a fixed cap, no matter
how many keyword hits, ALL CAPS, or `!!!` stack up — so one exceptionally
loaded message can't slam a value straight to the ceiling by itself.
Opposite-emotion pairs (e.g. Love/Disgust, Joy/Sadness) also share a
combined budget, so one side maxing out squeezes the other down rather
than both running free. On top of that, every exchange (a message and its
reply) gently nudges each axis back toward the character's own personal
baseline — subtly, so it doesn't erase a real emotional beat, just keeps
things from settling permanently at an extreme. Optionally (off by
default, enable in settings) mood also drifts back toward baseline as
real days pass between messages — love lingers (multi-day half-life),
fear/anger fade within about a day — for chats with long gaps between
sessions. Together these keep mood from getting stuck pinned at 0% or
100% forever once nothing is actively reinforcing it, while a genuinely
long, deep relationship still gets to keep an elevated resting point
rather than snapping back to a generic neutral.

## Group chats

Each member gets their own independently-tracked mood, seeded from their
own character card. A few rules specific to groups:

- A user message is the shared stimulus every active (non-muted) member
  just heard, so it nudges **all** of their moods.
- A character's own reply only ever updates **that character's own**
  mood — never another member's.
- Muted members keep their tracked mood (still viewable/resettable via the
  popup) but stop receiving the user-message broadcast and drop out of the
  injected prompt while muted.
- The floating badge/popup show whoever spoke most recently by default;
  use the dropdown at the top of the popup to view or edit any other
  member instead. Edit mode and "reset to baseline" only ever act on
  whichever member is currently selected there.
- The prompt gets one labeled `<emotional_state character="Name">` block
  per active member, every turn — token cost scales with group size, so
  "Token saver mode" (below) is worth turning on for larger groups.
- No `@mention` targeting — a user message can't be aimed at one specific
  member; it always reaches everyone active.

## What gets added to the prompt

Each turn, ChatMood injects a block into the system prompt (via
`setExtensionPrompt`, positioned with the character card/story string, not
appended to chat history). This text is always English — regardless of the
UI's language or the keyword-matching language setting — unlike the UI,
it's read by the model, not the user, and models handle a small,
clearly-delimited English block dropped into an otherwise non-English
prompt without trouble.

```
<emotional_state>
Temperament ({MBTI type}): {energy}; {perception}; {decision style}; {structure}.
Feeling right now: {Emotion} ({intensity tier}, XX%) · {Emotion} ({intensity tier}, XX%) · ...
Tone: {behavioral guidance for the dominant emotion}
Bond: {optional long-term trust/affection note}
Express this through tone, phrasing, and energy — do not name or announce emotions directly unless asked.
</emotional_state>
```

- Up to 4 emotions are listed (any at ≥12%, highest first).
- The `Bond:` line only appears once enough long-term trust/joy has
  drifted up or down — omitted in the neutral middle range.
- The `Temperament:` line is omitted entirely when token saver mode is on.
- Nothing is injected if mood is disabled for the chat, or no chat is open.

## Settings

SillyTavern → Extensions panel → **ChatMood**: enable-by-default toggle,
token saver mode, static position (off by default — pins the badge/popup
above the chat box instead of letting you drag them around), time-based
mood decay (off by default — turn on for mood to also drift back toward
baseline as real days pass between messages, on top of the small
per-exchange drift that already happens either way), track-only mode (off
by default — stops the `<emotional_state>` block from being injected into
the prompt while mood tracking and the UI keep working as usual), keyword-matching
language (English/German, requires a reload), personality inference
language (English/German/both, for MBTI + archetype detection from the
character card — no reload needed), message-weighting sliders, and a
reset-to-baseline button for the chat (or, in a group chat, member)
you're currently viewing.

## Installation

Drop this folder in `data/<user-handle>/extensions/ChatMood/` (per-user) or
`public/scripts/extensions/third-party/ChatMood/` (global), then reload
SillyTavern.

## Credits

The emotion engine (`lib/emotion-engine.js`) and the draggable floating
badge are adapted from [EchoText](https://github.com/mattjaybe/SillyTavern-EchoText)
(MIT License, © mattjaybe).
