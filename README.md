# ChatMood

A persistent, per-chat emotional state tracker for SillyTavern's main chat.
The character's mood evolves from the conversation and feeds back into the
prompt, so their tone shifts with how the conversation has actually gone.

## Features

- 9-axis Plutchik mood (love, joy, trust, fear, surprise, sadness, disgust,
  anger, anticipation), stored per chat — a new chat with the same character
  starts fresh.
- Floating badge showing the dominant emotion; click for a breakdown
  popup. By default both are pinned in a static spot above the chat box;
  optionally switch to a draggable, freely-positioned badge/popup instead.
- Delta burst animation showing what just changed, above the message input.
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

There's no time-based decay — mood only changes when a message is actually
processed, not by real-world time passing between messages (the main chat is
a story, not a texting thread where silence itself carries meaning).

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
token saver mode, static position (on by default — pins the badge/popup
above the chat box instead of letting you drag them, so they can never end
up positioned off-screen), keyword-matching language (English/German,
requires a reload), personality inference language (English/German/both,
for MBTI + archetype detection from the character card — no reload
needed), message-weighting sliders, and a reset-to-baseline button for the
chat you're currently in.

## Installation

Drop this folder in `data/<user-handle>/extensions/ChatMood/` (per-user) or
`public/scripts/extensions/third-party/ChatMood/` (global), then reload
SillyTavern.

## Credits

The emotion engine (`lib/emotion-engine.js`) and the draggable floating
badge are adapted from [EchoText](https://github.com/mattjaybe/SillyTavern-EchoText)
(MIT License, © mattjaybe).
