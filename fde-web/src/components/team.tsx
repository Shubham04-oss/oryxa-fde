import { useId, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, Failed, Loading, Quiet, Row, Rows } from "./page"
import { NamesUnavailable, PersonAvatar, PersonName, useNames } from "./people"
import type { Names } from "./people"
import { Button } from "./ui/button"
import { FIELD } from "./task-move"
import { api, queries } from "@/lib/api/client"
import type { CompanyId, MemberRole, ProjectScope, UserId } from "@/lib/api/schemas"
import { clip } from "@/lib/access"
import { byName } from "@/lib/people"
import { attempt, commitPeople } from "@/lib/records"
import { shortDate, dayOf } from "@/lib/time"
import { cn } from "@/lib/utils"

// Who works on a company and on a project (DESIGN.md §3), by name (lib/people.ts). A lead or admin
// adds someone from the organisation's people, and assigns engineers from the company's team.

const ROLE_LABEL: Record<MemberRole, string> = { lead: "Lead", engineer: "Engineer" }

/** A person in a row: their initials and their name. */
function Who({ user, names }: { user: string; names: Names }) {
  const person = names.of(user)
  const me = useQuery(queries.me())
  return (
    <div className="flex min-w-0 items-center gap-3">
      <PersonAvatar person={person} me={me.data?.user.name} />
      <PersonName person={person} className="text-xs" />
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
      {/* The button that asked is gone: focus lands on the safe answer. */}
      <Button variant="ghost" size="sm" autoFocus onClick={() => setAsking(false)}>
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

/**
 * The company's leads and engineers; a lead or admin changes a role or removes someone. The API lets
 * the last lead go (a finding for the API stream), so the screen never offers it, and asks before
 * anyone is removed or a lead steps down.
 */
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
  const names = useNames({ company })
  // The person a save is in flight for, and a refusal, kept in their row.
  const [saving, setSaving] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ user: string; why: string } | null>(null)
  // Stepping down from lead, once asked.
  const [steppingDown, setSteppingDown] = useState(false)

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
            const you = member.user === me
            const onlyLead =
              member.role === "lead" && members.data.filter((m) => m.role === "lead").length === 1
            return (
              <Row key={member.user}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <Who user={member.user} names={names} />
                  <div className="flex items-center gap-2">
                    {manage && !onlyLead ? (
                      <select
                        aria-label={`Role of ${names.of(member.user).phrase}`}
                        className={cn(FIELD, "w-auto")}
                        value={member.role}
                        disabled={busy || (you && steppingDown)}
                        onChange={(e) => {
                          const role = e.target.value as MemberRole
                          if (you && member.role === "lead" && role === "engineer")
                            setSteppingDown(true)
                          else void run(member.user, role)
                        }}
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
                    {manage && !onlyLead && (
                      <RemoveButton
                        name={you ? "yourself" : names.of(member.user).phrase}
                        ask="Remove from this company?"
                        disabled={busy}
                        onRemove={() => void run(member.user, null)}
                      />
                    )}
                  </div>
                </div>
                {manage && onlyLead && (
                  <Quiet className="mt-1">
                    A company always has a lead. Make someone else lead first.
                  </Quiet>
                )}
                {you && steppingDown && (
                  <div
                    role="group"
                    aria-label="Confirm stepping down"
                    className="mt-1 flex flex-wrap items-center gap-1"
                  >
                    <span className="mr-auto text-[11px] text-muted-foreground">
                      Step down to engineer? A lead or an organisation admin then manages this
                      company.
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      autoFocus
                      onClick={() => setSteppingDown(false)}
                    >
                      Keep
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setSteppingDown(false)
                        void run(member.user, "engineer")
                      }}
                    >
                      Step down
                    </Button>
                  </div>
                )}
                {busy && <Quiet>Saving…</Quiet>}
                {refused?.user === member.user && (
                  <Said text={refused.why} onDismiss={() => setRefused(null)} />
                )}
              </Row>
            )
          })}
        </Rows>
      )}
      <NamesUnavailable names={names} className="mt-2" />
      {manage && members.isSuccess && (
        <AddMember company={company} team={members.data.map((m) => m.user)} names={names} />
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
  const names = useNames(scope)
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

  const roles = new Map((team.data ?? []).map((m) => [m.user as string, m.role]))
  const left = byName(
    (team.data ?? [])
      .filter((m) => !(assigned.data ?? []).some((a) => a.user === m.user))
      .map((m) => names.of(m.user)),
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
                <Who user={a.user} names={names} />
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    Since {shortDate(dayOf(a.added_at))}
                  </span>
                  {manage && (
                    <RemoveButton
                      name={a.user === me ? "yourself" : names.of(a.user).phrase}
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
            className={cn(FIELD, "w-auto min-w-44")}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">Choose from the team</option>
            {left.map((p) => (
              <option key={p.id} value={p.id} title={p.label}>
                {clip(p.label, 60)}, {ROLE_LABEL[roles.get(p.id) ?? "engineer"].toLowerCase()}
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
      <NamesUnavailable names={names} className="mt-2" />
    </Card>
  )
}

/**
 * Adds someone from the organisation's people to the company, with a role. Only `/v1/people` says who
 * they are, so when it cannot answer the card says so and offers nobody, never an empty list.
 */
function AddMember({
  company,
  team,
  names,
}: {
  company: CompanyId
  team: ReadonlyArray<string>
  names: Names
}) {
  const client = useQueryClient()
  const people = useQuery(queries.people())
  const [choice, setChoice] = useState("")
  const [role, setRole] = useState<MemberRole>("engineer")
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const heading = useId()
  const add = useMutation({
    mutationFn: async () => api.setMember(company, choice as UserId, role),
    onSuccess: () => commitPeople(client),
  })

  async function run() {
    setSaving(true)
    setRefused(null)
    const why = await attempt(() => add.mutateAsync(), "person")
    setSaving(false)
    if (why) setRefused(why)
    else setChoice("")
  }

  if (people.isPending)
    return <Quiet className="mt-3">Loading the organisation&apos;s people…</Quiet>
  if (people.isError)
    return (
      <Quiet className="mt-3">
        No one can be added to the team until the organisation&apos;s people can be read.
      </Quiet>
    )
  const others = byName(people.data.filter((p) => !team.includes(p.id)).map((p) => names.of(p.id)))
  if (others.length === 0)
    return <Quiet className="mt-3">Everyone in the organisation is on this team.</Quiet>
  return (
    <form
      aria-labelledby={heading}
      className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (choice) void run()
      }}
    >
      <h3 id={heading} className="basis-full text-[11px] text-muted-foreground">
        Add to the team
      </h3>
      <select
        aria-label="Add from the organisation"
        className={cn(FIELD, "w-auto max-w-80 min-w-44")}
        value={choice}
        disabled={saving}
        onChange={(e) => setChoice(e.target.value)}
      >
        <option value="">Choose someone to add</option>
        {others.map((p) => (
          <option key={p.id} value={p.id} title={p.label}>
            {clip(p.label, 60)}
          </option>
        ))}
      </select>
      <select
        aria-label="Their role"
        className={cn(FIELD, "w-auto")}
        value={role}
        disabled={saving}
        onChange={(e) => setRole(e.target.value as MemberRole)}
      >
        {(Object.keys(ROLE_LABEL) as Array<MemberRole>).map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline" disabled={!choice || saving}>
        {saving ? "Adding…" : "Add"}
      </Button>
      {refused && (
        <div className="basis-full">
          <Said text={refused} onDismiss={() => setRefused(null)} />
        </div>
      )}
    </form>
  )
}
