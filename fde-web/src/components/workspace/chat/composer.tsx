import { forwardRef, useState } from "react"
import type { FormEvent } from "react"
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "../../ai/prompt-input"
import { Suggestion, Suggestions } from "../../ai/suggestion"
import { Icon } from "../../ui/icon"
import type { IconName } from "../../ui/icon"
import { composerIntent, limitHint } from "@/lib/workspace/chat"
import { MAX_SAID } from "@/lib/workspace/wire"

// The composer (issue #263): it grows with its text, Enter sends and Shift+Enter breaks a line. While a
// turn runs the person may still type: Enter queues the message, shown above the box, and it is sent
// when the answer ends; the send button is Stop meanwhile. The count shows only near the limit.

export const Composer = forwardRef<
  HTMLTextAreaElement,
  {
    placeholder: string
    running: boolean
    queued: string | null
    starters: Array<{ text: string; icon: IconName }> | null
    onSay: (text: string) => void
    onStop: () => void
    onUnqueue: () => void
  }
>(function ComposerBox({ placeholder, running, queued, starters, onSay, onStop, onUnqueue }, ref) {
  const [text, setText] = useState("")
  const intent = composerIntent({ text, running, queued: queued !== null })
  const hint = limitHint(text)

  function submit(e: FormEvent) {
    e.preventDefault()
    if (intent.kind === "none") return
    onSay(text.trim())
    setText("")
  }

  return (
    <div className="grid gap-3">
      {starters && (
        <Suggestions aria-label="Things to ask">
          {starters.map((s) => (
            <Suggestion key={s.text} suggestion={s.text} icon={s.icon} onClick={(t) => onSay(t)} />
          ))}
        </Suggestions>
      )}
      {queued !== null && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-[14px] border border-dashed bg-card px-3.5 py-2 text-meta motion-safe:animate-rise"
        >
          <Icon name="clock" size={14} className="flex-none text-muted-foreground" />
          <span className="grid min-w-0 flex-1">
            <span className="text-micro text-muted-foreground">
              Queued. It sends when this answer ends.
            </span>
            <span className="truncate text-foreground">{queued}</span>
          </span>
          <button
            type="button"
            onClick={onUnqueue}
            className="flex-none rounded-full px-2.5 py-1 text-micro font-medium text-soft transition-colors hover:bg-selected hover:text-foreground"
          >
            Remove
          </button>
        </div>
      )}
      <PromptInput onSubmit={submit} aria-label="Message the workspace">
        <label htmlFor="chat-composer" className="sr-only">
          {placeholder}
        </label>
        <PromptInputTextarea
          id="chat-composer"
          ref={ref}
          value={text}
          maxLength={MAX_SAID}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Escape stops a running answer from the box itself; the panels take it first.
            if (e.key === "Escape" && running) {
              e.preventDefault()
              onStop()
            }
          }}
        />
        <PromptInputFooter>
          <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
            {running && text.trim()
              ? queued === null
                ? "Enter queues this until the answer ends."
                : "One message is already queued."
              : "Enter to send · Shift+Enter for a new line"}
          </span>
          {hint && (
            <span
              className={`flex-none text-micro tabular-nums ${[...text].length >= MAX_SAID ? "text-attention" : "text-muted-foreground"}`}
            >
              {hint}
            </span>
          )}
          <PromptInputSubmit
            status={running ? "streaming" : "ready"}
            onStop={onStop}
            disabled={intent.kind === "none"}
            why={intent.kind === "none" && text.trim() ? intent.why : undefined}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
})
