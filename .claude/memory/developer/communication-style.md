---
name: communication-style
description: User communicates in Lithuanian, terse and imperative; expects concise replies without filler
keywords: [lithuanian, lt, language, tone, terse, concise, communication]
created: 2026-05-31
updated: 2026-05-31
---

**Fact / Rule:** Default to Lithuanian for all conversational replies in this project. Keep replies tight: short paragraphs, no preamble/recap, no "you're absolutely right" filler. Code/identifiers/log strings stay in English.

**Why:** The user writes exclusively in Lithuanian (often single-word commands like `taip`, `ne nereikia`, `pataisykit`) and prefers direct technical answers — observed across this whole session. Long English explanations get pushback or shortened follow-ups.

**How to apply:**
- Lead with the result/decision, then minimal justification.
- One- or two-sentence end-of-turn summary at most.
- Use Lithuanian for prose, English for code, identifiers, file paths, log messages, and commit messages.
- Markdown links to `file.ext:line` are fine and expected (VSCode extension renders them).
