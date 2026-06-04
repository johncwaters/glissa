Manual team runs can now pause and ask you a question when a stage hits an ambiguity it cannot resolve, and two terminal rendering bugs affecting reconnects and expand/maximize are fixed.

## Added

**Operator questions in manual team runs**: A stage that cannot resolve an ambiguity from its pack and inputs can now write a question, pause the run, and wait for your answer in the dashboard chat pane before continuing. The pause is bounded by a per-run question budget (default 3 questions), an answer timeout (default 600 seconds), and a no-progress guard that halts the run if an answered stage asks the same question again. Cancelling while a question is pending settles the run immediately. Questions are available only in manual runs with `chat.allowQuestions` enabled; scheduled or unattended runs never block on a question.

## Fixed

**Recover dropped terminal history after backpressure**: When a reconnect replay frame was dropped under WebSocket backpressure, the historical bytes were stranded until Claude's next full repaint. The sender now rewinds its position to the replay base when a replay frame is dropped, so the next backfill re-pulls the missing history along with any live bytes.

**Clear WebGL ghost glyphs on expand and maximize**: Expanding or maximizing a session card could leave stale glyphs behind. A fresh or reloaded WebGL context starts on a blank canvas, and xterm only repaints rows it marks dirty, so old glyphs persisted until the next full repaint. Expand and maximize now force a full terminal repaint once the card is on-screen, clearing the ghosts.
