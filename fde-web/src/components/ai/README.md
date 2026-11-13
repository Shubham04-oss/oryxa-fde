# Copied-in conversation components

Presentational components copied into the repo, shadcn style, for the conversation prototype (issue #263).
Each file says where it came from, at which commit, under which licence, and what changed. None of them
brings a transport, a chat hook or a runtime: the screen feeds them our own typed parts
(`src/lib/workspace/chat.ts`). Model text is never rendered as markdown or HTML here.

| File                                                                                                                        | Source                                                                                     | Licence                               |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `message.tsx`, `bubble.tsx`, `marker.tsx`                                                                                   | shadcn/ui, base-nova registry (`message`, `bubble`, `marker`), `shadcn-ui/ui` at `e62c943` | MIT, `LICENSE-shadcn.md`              |
| `tool.tsx`, `task.tsx`, `plan.tsx`, `confirmation.tsx`, `shimmer.tsx`, `suggestion.tsx`, `prompt-input.tsx`, `artifact.tsx` | Vercel AI Elements, `packages/elements/src/`, `vercel/ai-elements` at `ca8be60`            | Apache-2.0, `LICENSE-ai-elements.txt` |

Rebased from Radix onto Base UI (`Collapsible`, `Tooltip`), restyled on our tokens, and icons through
`components/ui/icon.tsx`. Left out on purpose: AI Elements' `MessageResponse`, `Streamdown`, `Reasoning`,
`InlineCitation`, and the Tool's raw JSON input and output; shadcn's `MessageScroller`, which needs the
`@shadcn/react` runtime package.
