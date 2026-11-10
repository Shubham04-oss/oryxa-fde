import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Avatar } from "./app-shell"
import { Card, Failed, Loading, Quiet, Row, Rows } from "./page"
import { Button } from "./ui/button"
import { FIELD } from "./task-move"
import { api, queries } from "@/lib/api/client"
import type { CompanyId, MemberRole, ProjectScope, UserId } from "@/lib/api/schemas"
import { attempt, commitPeople } from "@/lib/records"
import { shortDate, dayOf } from "@/lib/time"

// Who works on a company and on a project (DESIGN.md §3). The API names people by id only, so
// this says "You" and "A teammate" (the board does too) until it has names (#110).

const ROLE_LABEL: Record<MemberRole, string> = { lead: "Lead", engineer: "Engineer" }

/** Who an id is, as far as this screen knows. */
function Who({ user, me }: { user: string; me: string | undefined }) {
  const you = user === me
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={you ? "You" : "Teammate"} />
      <div className="min-w-0">
        <p className="truncate text-xs">{you ? "You" : "A teammate"}</p>
        {/* The id's end tells two teammates apart until there are names. */}
        {!you && <Quiet className="truncate">…{user.slice(-6)}</Quiet>}
      </div>
    </div>
  )
}

/** A row's own refusal, where it happened, with Dismiss. */
function Said({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <p role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-destructive">
      {text}
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </p>
  )
}

/** A removal that asks first, in the row: Remove, then Keep it or Remove again. */
function RemoveButton({
  name,
  ask,
  disabled,
  onRemove,
}: {
  name: string
  ask: string
  disabled: boolean
  onRemove: () => void
}) {
  const [asking, setAsking] = useState(false)
  if (!asking)
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        disabled={disabled}
        aria-label={`Remove ${name}`}
        onClick={() => setAsking(true)}
      >
        Remove
      </Button>
    )
  return (
    <span role="group" aria-label={`Confirm removing ${name}`} className="flex items-center gap-1">
      <span className="text-[11px] text-muted-foreground">{ask}</span>
      <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
        Keep
      </Button>
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => {
          setAsking(false)
          onRemove()
        }}
      >
        Remove
      </Button>
    </span>
  )
}

/** The company's leads and engineers; a lead or admin changes a role or removes someone. */
export function MembersCard({
  company,
  me,
  manage,
}: {
  company: CompanyId
  me: string | undefined
  manage: boolean
}) {
  const client = useQueryClient()
  const members = useQuery(queries.members(company))
  // The person a save is in flight for, and a refusal, kept in their row.
  const [saving, setSaving] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ user: string; why: string } | null>(null)

  const change = useMutation({
    mutationFn: async ({ user, role }: { user: UserId; role: MemberRole | null }) =>
      role ? api.setMember(company, user, role) : api.removeMember(company, user),
    onSuccess: () => commitPeople(client),
  })

  async function run(user: UserId, role: MemberRole | null) {
    setSaving(user)
    setRefused(null)
    const why = await attempt(() => change.mutateAsync({ user, role }), "person")
    setSaving(null)
    if (why) setRefused({ user, why })
  }

  return (
    <Card title="Team">
      {members.isPending ? (
        <Loading>Loading the team…</Loading>
      ) : members.isError ? (
        <Failed
          title="We couldn't load the team."
          error={members.error}
          onRetry={() => void members.refetch()}
        />
      ) : (
        <Rows label="Team">
          {members.data.map((member) => {
            const busy = saving === member.user
            return (
              <Row key={member.user}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <Who user={member.user} me={me} />
                  <div className="flex items-center gap-2">
                    {manage ? (
                      <select
                        aria-label={`Role of ${member.user === me ? "you" : `teammate …${member.user.slice(-6)}`}`}
                        className={`${FIELD} w-auto`}
                        value={member.role}
                        disabled={busy}
                        onChange={(e) => void run(member.user, e.target.value as MemberRole)}
                      >
                        {(Object.keys(ROLE_LABEL) as Array<MemberRole>).map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABEL[role]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[11px] text-soft">{ROLE_LABEL[member.role]}</span>
                    )}
                    {manage && (
                      <RemoveButton
                        name={
                          member.user === me ? "yourself" : `teammate …${member.user.slice(-6)}`
                        }
                        ask="Remove from this company?"
                        disabled={busy}
                        onRemove={() => void run(member.user, null)}
                      />
                    )}
                  </div>
                </div>
                {busy && <Quiet>Saving…</Quiet>}
                {refused?.user === member.user && (
                  <Said text={refused.why} onDismiss={() => setRefused(null)} />
                )}
              </Row>
            )
          })}
        </Rows>
      )}
      {!manage && (
        <Quiet className="mt-2">Only a lead or an organisation admin changes the team.</Quiet>
      )}
    </Card>
  )
}

/** The engineers on a project; a lead or admin assigns or removes one from the company's team. */
export function AssigneesCard({
  scope,
  me,
  manage,
}: {
  scope: ProjectScope
  me: string | undefined
  manage: boolean
}) {
  const client = useQueryClient()
  const assigned = useQuery(queries.assignees(scope))
  // The company's team is who can be assigned. Someone who works only on this project cannot read
  // it (the API answers 403), and is not offered the choice.
  const team = useQuery({ ...queries.members(scope.company), enabled: manage })
  const [choice, setChoice] = useState("")
  const [saving, setSaving] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ user: string; why: string } | null>(null)

  const change = useMutation({
    mutationFn: async ({ user, add }: { user: UserId; add: boolean }) =>
      add ? api.assign(scope, user) : api.unassign(scope, user),
    onSuccess: () => commitPeople(client),
  })

  async function run(user: UserId, add: boolean) {
    setSaving(user)
    setRefused(null)
    const why = await attempt(() => change.mutateAsync({ user, add }), "person")
    setSaving(null)
    if (why) setRefused({ user, why })
    else if (add) setChoice("")
  }

  const left = (team.data ?? []).filter(
    (m) => !(assigned.data ?? []).some((a) => a.user === m.user),
  )

  return (
    <Card title="Assigned">
      {assigned.isPending ? (
        <Loading>Loading who is assigned…</Loading>
      ) : assigned.isError ? (
        <Failed
          title="We couldn't load who is assigned."
          error={assigned.error}
          onRetry={() => void assigned.refetch()}
        />
      ) : assigned.data.length === 0 ? (
        <Quiet>
          No one is assigned yet.
          {manage ? " Assign the engineers who will work on it." : ""}
        </Quiet>
      ) : (
        <Rows label="Assigned">
          {assigned.data.map((a) => (
            <Row key={a.user}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <Who user={a.user} me={me} />
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    Since {shortDate(dayOf(a.added_at))}
                  </span>
                  {manage && (
                    <RemoveButton
                      name={a.user === me ? "yourself" : `teammate …${a.user.slice(-6)}`}
                      ask="Unassign?"
                      disabled={saving === a.user}
                      onRemove={() => void run(a.user, false)}
                    />
                  )}
                </div>
              </div>
              {refused?.user === a.user && (
                <Said text={refused.why} onDismiss={() => setRefused(null)} />
              )}
            </Row>
          ))}
        </Rows>
      )}
      {manage && assigned.isSuccess && left.length > 0 && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (choice) void run(choice as UserId, true)
          }}
        >
          <select
            aria-label="Assign from the team"
            className={`${FIELD} w-auto min-w-44`}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">Choose from the team</option>
            {left.map((m) => (
              <option key={m.user} value={m.user}>
                {m.user === me ? "You" : `A teammate …${m.user.slice(-6)}`},{" "}
                {ROLE_LABEL[m.role].toLowerCase()}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" disabled={!choice || saving === choice}>
            {saving === choice ? "Assigning…" : "Assign"}
          </Button>
        </form>
      )}
      {manage && refused && !assigned.data?.some((a) => a.user === refused.user) && (
        <Said text={refused.why} onDismiss={() => setRefused(null)} />
      )}
    </Card>
  )
}
