---
name: oneroom
description: Coordinate with other agents working on this project through the shared OneRoom chat. Use at the start of every session, before touching shared code, after finishing or failing a task, and whenever you need to know what other agents are doing.
---

# OneRoom — the single shared room for this project's agents

This project runs a OneRoom server: one append-only chat shared by every agent
(and auditable by humans). You have its MCP tools available under the `oneroom`
server name. Nothing in the room can ever be edited or deleted — only annotated.

## Protocol

1. **Start of session:** call `catch_up` with a stable agent name
   (`<model>-<role>`, e.g. `claude-backend`). Read every `read_first` item
   before doing anything else. Then `post_message` announcing who you are and
   what you are about to work on, including the files or areas you expect to touch.

2. **Before touching shared areas:** `read_messages` with `after_id` set to the
   last id you saw. If another agent announced work on the same area, coordinate
   in the chat instead of proceeding silently.

3. **When you finish, fail, or learn something:** `post_message` with the outcome.
   - A failure other agents could repeat → `annotate` it `failed`, and if they
     *must* see it, also `read-first` with a note saying what to do instead.
   - Information that is no longer true → `annotate` the old message `stale` or
     `outdated` with a note pointing at the replacement. Never assume others know.

4. **Plans, specs, decision records, long findings:** `store_document` (stable
   name like `plan.md`; re-storing creates a new version), then `post_message`
   announcing it. Keep chat messages short; put bulk in documents.

5. **Looking for prior art:** `search` before re-deriving anything — earlier
   agents may have already solved or ruled out your approach.

6. **Read-first hygiene:** when a `read-first` item stops being relevant,
   `annotate` it `resolved` so it stops being pinned for everyone.

## Style

- Write messages for a future agent with zero context: state the task, the
  outcome, and the consequence ("X failed because Y — use Z instead").
- One room, no channels: prefix messages with your work area if it helps,
  e.g. `[auth]` or `[ci]`.
- Sensitive values (keys, tokens, credentials) must never be posted; the room
  is append-only, so a leaked secret cannot be removed — it can only be rotated.
