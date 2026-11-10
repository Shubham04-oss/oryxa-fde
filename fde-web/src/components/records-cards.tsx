import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Avatar } from "./app-shell"
import { FormDialog, TextArea, TextField } from "./form-dialog"
import { Card, Quiet, Row, Rows } from "./page"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { FIELD, Labelled } from "./task-move"
import { api } from "@/lib/api/client"
import type { CompanyId, StakeholderOut, StakeholderPart, SystemOut } from "@/lib/api/schemas"
import {
  PART_LABEL,
  attempt,
  commitRecord,
  stakeholderBody,
  stakeholderFields,
  stakeholderProblem,
  systemBody,
  systemFields,
  systemProblem,
} from "@/lib/records"

// The company's stakeholders and systems (DESIGN.md §3): a list, with add, edit and remove. A row
// opens its form; removing asks first. Anyone who works on the company may change them.

const PARTS = Object.keys(PART_LABEL) as Array<StakeholderPart>

/** A row that is also the button that edits it. `id` marks it, so focus can come back to it. */
export function EditRow({
  label,
  id,
  onOpen,
  children,
}: {
  label: string
  id?: string
  onOpen: () => void
  children: React.ReactNode
}) {
  return (
    <Row>
      <button
        type="button"
        data-row={id}
        aria-label={label}
        onClick={onOpen}
        className="-mx-2 block w-[calc(100%+16px)] rounded-lg px-2 py-1 text-left hover:bg-selected"
      >
        {children}
      </button>
    </Row>
  )
}

export function StakeholdersCard({
  company,
  people,
}: {
  company: CompanyId
  people: Array<StakeholderOut>
}) {
  // A person to edit, "new" for a blank form, or nothing.
  const [open, setOpen] = useState<StakeholderOut | "new" | null>(null)
  return (
    <Card
      title="Stakeholders"
      aside={
        <Button variant="outline" size="sm" onClick={() => setOpen("new")}>
          Add stakeholder
        </Button>
      }
    >
      {people.length === 0 ? (
        <Quiet>
          No stakeholders yet. Add the people you work with at the customer: the sponsor who signs
          off, a champion, someone in IT.
        </Quiet>
      ) : (
        <Rows>
          {people.map((person) => (
            <EditRow key={person.id} label={`Edit ${person.name}`} onOpen={() => setOpen(person)}>
              <div className="flex items-center gap-3">
                <Avatar name={person.name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs">{person.name}</p>
                  {person.title && <Quiet className="truncate">{person.title}</Quiet>}
                </div>
                <span className="flex-none text-[11px] text-soft">{PART_LABEL[person.role]}</span>
              </div>
            </EditRow>
          ))}
        </Rows>
      )}
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        {open && (
          <StakeholderDialog
            key={open === "new" ? "new" : open.id}
            company={company}
            person={open === "new" ? undefined : open}
            onClose={() => setOpen(null)}
          />
        )}
      </Dialog>
    </Card>
  )
}

function StakeholderDialog({
  company,
  person,
  onClose,
}: {
  company: CompanyId
  person?: StakeholderOut
  onClose: () => void
}) {
  const client = useQueryClient()
  const [fields, setFields] = useState(stakeholderFields(person))
  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch })

  // The whole record goes back on an edit (the API's PUT replaces it), so what the form holds is
  // every field the record has.
  const save = () =>
    attempt(async () => {
      const body = stakeholderBody(fields)
      const saved = person
        ? await api.updateStakeholder(company, person.id, body)
        : await api.addStakeholder(company, body)
      await commitRecord(client, company, "stakeholders", { saved })
    }, "stakeholder")

  return (
    <FormDialog
      title={person ? "Edit stakeholder" : "Add stakeholder"}
      description={person ? "Change this person, or remove them." : "Add a person at the customer."}
      save={person ? "Save" : "Add stakeholder"}
      validate={() => stakeholderProblem(fields)}
      onSubmit={save}
      remove={
        person && {
          label: "Remove stakeholder",
          ask: `Remove ${person.name}? Access requests they own and tasks waiting on them will no longer name them. This cannot be undone.`,
          group: "Confirm the removal",
          confirm: "Remove",
          run: () =>
            attempt(async () => {
              await api.removeStakeholder(company, person.id)
              await commitRecord(client, company, "stakeholders", { gone: person.id })
            }, "stakeholder"),
        }
      }
      onClose={onClose}
    >
      <TextField autoFocus label="Name" value={fields.name} onChange={(name) => set({ name })} />
      <div className="grid grid-cols-2 items-start gap-2 max-[560px]:grid-cols-1">
        <Labelled label="Their part">
          <select
            className={FIELD}
            value={fields.role}
            onChange={(e) => set({ role: e.target.value as StakeholderPart })}
          >
            {PARTS.map((part) => (
              <option key={part} value={part}>
                {PART_LABEL[part]}
              </option>
            ))}
          </select>
        </Labelled>
        <TextField label="Job title" value={fields.title} onChange={(title) => set({ title })} />
      </div>
      <TextField
        label="Email"
        type="email"
        value={fields.email}
        onChange={(email) => set({ email })}
        hint="Where a sponsor's weekly digest goes. A new address starts getting it."
      />
    </FormDialog>
  )
}

export function SystemsCard({
  company,
  systems,
}: {
  company: CompanyId
  systems: Array<SystemOut>
}) {
  const [open, setOpen] = useState<SystemOut | "new" | null>(null)
  return (
    <Card
      title="Systems"
      aside={
        <Button variant="outline" size="sm" onClick={() => setOpen("new")}>
          Add system
        </Button>
      }
    >
      {systems.length === 0 ? (
        <Quiet>
          No systems yet. Add what the work touches at the customer, such as a CRM, a data warehouse
          or a ticket queue.
        </Quiet>
      ) : (
        <Rows>
          {systems.map((system) => (
            <EditRow key={system.id} label={`Edit ${system.name}`} onOpen={() => setOpen(system)}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-xs">{system.name}</p>
                {system.kind && (
                  <span className="flex-none text-[11px] text-soft">{system.kind}</span>
                )}
              </div>
              {system.description && <Quiet>{system.description}</Quiet>}
            </EditRow>
          ))}
        </Rows>
      )}
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        {open && (
          <SystemDialog
            key={open === "new" ? "new" : open.id}
            company={company}
            system={open === "new" ? undefined : open}
            onClose={() => setOpen(null)}
          />
        )}
      </Dialog>
    </Card>
  )
}

function SystemDialog({
  company,
  system,
  onClose,
}: {
  company: CompanyId
  system?: SystemOut
  onClose: () => void
}) {
  const client = useQueryClient()
  const [fields, setFields] = useState(systemFields(system))
  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch })

  const save = () =>
    attempt(async () => {
      const body = systemBody(fields)
      const saved = system
        ? await api.updateSystem(company, system.id, body)
        : await api.addSystem(company, body)
      await commitRecord(client, company, "systems", { saved })
    }, "system")

  return (
    <FormDialog
      title={system ? "Edit system" : "Add system"}
      description={system ? "Change this system, or remove it." : "Add a system at the customer."}
      save={system ? "Save" : "Add system"}
      validate={() => systemProblem(fields)}
      onSubmit={save}
      remove={
        system && {
          label: "Remove system",
          ask: `Remove ${system.name}? Access requests that name it will no longer name a system. This cannot be undone.`,
          group: "Confirm the removal",
          confirm: "Remove",
          run: () =>
            attempt(async () => {
              await api.removeSystem(company, system.id)
              await commitRecord(client, company, "systems", { gone: system.id })
            }, "system"),
        }
      }
      onClose={onClose}
    >
      <TextField autoFocus label="Name" value={fields.name} onChange={(name) => set({ name })} />
      <TextField
        label="Kind"
        value={fields.kind}
        onChange={(kind) => set({ kind })}
        hint="Such as CRM or data warehouse."
      />
      <TextArea
        label="Description"
        value={fields.description}
        onChange={(description) => set({ description })}
        hint="What it holds, and anything to know before touching it."
      />
    </FormDialog>
  )
}
