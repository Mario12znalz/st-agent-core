# Agent Core — Skills & Self-Review for SillyTavern

Turns SillyTavern into an agent-like system with:

## Skills

Persistent behavior rules injected into every AI generation — like Hermes Agent's skills for SillyTavern.

- Create skills like *"Always use Victorian-era vocabulary"* or *"Keep responses under 3 paragraphs"*
- Toggle on/off per skill
- Skills are injected as system messages before every generation via the prompt interceptor
- Extract skills **from self-review fixes** — when the AI identifies an issue, click "Extract as Skill" to make it permanent

## Self-Review

The AI critiques its own response for quality, character voice, pacing, and coherence:

1. Click the **🔍** button on any AI message
2. A background generation reviews the response against the conversation context
3. A popup shows issues, fixes, and revised passages
4. **Extract as Skill** — turn any fix into a permanent behavior rule
5. The **Apply** button regenerates the response with the fixes injected as guidance

Auto-review mode runs this automatically after every AI reply.

## How it works

- **Interceptor**: `agentCoreInterceptor` in `manifest.json` — injects all enabled Skills as a synthetic system message before every generation.
- **Review**: Uses `generateQuietPrompt()` to run a private review generation in the background. The review JSON is stored on the chat message's `extra.agentCoreReview` field.
- **Skill extraction**: Review fixes are user-validated and stored as permanent Skills in `extension_settings['agent-core'].skills`.
- **Review button**: Hooked into `CHARACTER_MESSAGE_RENDERED` and `GENERATION_ENDED` events to attach review buttons to AI messages.

## Installation

In SillyTavern: **Extensions → Install Extension** → paste:

```
https://github.com/Mario12znalz/st-agent-core
```

Enable in **Manage Extensions**.