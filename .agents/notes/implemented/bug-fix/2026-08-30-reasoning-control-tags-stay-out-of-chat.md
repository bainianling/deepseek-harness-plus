# Agent Note: Reasoning control tags stay out of chat

Status: implemented

English | [中文](2026-08-30-reasoning-control-tags-stay-out-of-chat.zh.md)

## Problem

Some reasoning providers occasionally include XML-like control delimiters such as `<thinking>` or `<analysis>` in the reasoning text they stream. The Harness already carries reasoning in its own block type, so rendering those delimiters exposes transport-oriented markup without adding information. A delimiter can also arrive across chunk boundaries, briefly leaving a partial tag visible in the running summary.

The coding-agent persona can increase the incidence when it asks for thinking or reasoning in user-visible replies. This conflates the provider reasoning channel with commentary and final-answer text.

## Decision

`ReasoningRow` derives presentation text from the durable reasoning block. It removes complete `think`, `thinking`, and `analysis` delimiters case-insensitively and withholds a trailing prefix of one of those delimiters while a stream is assembling it. The session event and stored reasoning text remain unchanged for replay and diagnostics.

The standard coding persona asks the model to keep private reasoning in the provider reasoning channel and forbids internal control markup in user-visible commentary and final answers. It also directs the model to reuse established facts, batch independent inspection, avoid repeated searches or plans, and move from sufficient evidence to focused implementation and verification.

## Alternatives considered

**Rewrite adapter stream events.** Rejected because the adapter would alter durable provider output and every downstream consumer, while the defect is presentation-specific and raw reasoning remains useful for diagnostics.

**Filter ordinary assistant text.** Rejected because users may legitimately request XML examples or discuss `<thinking>` syntax in a final answer. The reasoning row already identifies the only content class where these tokens are transport delimiters.

**Rely on the persona alone.** Rejected because historical sessions and provider-generated delimiters remain visible, and an upstream model may not obey the prompt consistently.

## Consequences

Both streaming summaries and expanded reasoning bodies omit the known delimiters, including an incomplete trailing delimiter prefix. Other angle-bracket text remains visible. The raw log remains lossless, and normal assistant Markdown is untouched. New sessions using the standard persona receive the efficiency and channel-separation guidance; a running preset generation retains its assembled prompt until the host or generation is replaced.
