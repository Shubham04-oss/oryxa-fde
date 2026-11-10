import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { FormDialog, TextArea, TextField } from "./form-dialog"
import { api } from "@/lib/api/client"
import type { CompanyOut, ProjectScope } from "@/lib/api/schemas"
import {
  attempt,
  commitCompanyChanged,
  commitCompanyCreated,
  commitProjectChanged,
  commitProjectCreated,
  companyBody,
  companyFields,
  companyPatch,
  companyProblem,
  projectBody,
  projectFields,
  projectPatch,
  projectProblem,
} from "@/lib/records"
import type { ProjectRecord } from "@/lib/records"

// The company and project forms (DESIGN.md §3). Creating one saves, then opens it; editing sends
// only what changed. Both wait for the API before they close.

/** A new company, or an edit of `company`. A new one opens on its page. */
export function CompanyDialog({ company, onClose }: { company?: CompanyOut; onClose: () => void }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [fields, setFields] = useState(companyFields(company))
  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch })

  async function save() {
    if (company) {
      const patch = companyPatch(company, fields)
      // Nothing changed: nothing to send.
      if (Object.keys(patch).length === 0) return null
      return attempt(
        async () => commitCompanyChanged(client, await api.updateCompany(company.id, patch)),
        "company",
      )
    }
    return attempt(async () => {
      const created = await api.createCompany(companyBody(fields))
      await commitCompanyCreated(client, created)
      await navigate({ to: "/companies/$companyId", params: { companyId: created.id } })
    }, "company")
  }

  return (
    <FormDialog
      title={company ? "Edit company" : "New company"}
      description={
        company ? "Change the company's profile." : "Add a customer company you work with."
      }
      save={company ? "Save" : "Create company"}
      validate={() => companyProblem(fields)}
      onSubmit={save}
      onClose={onClose}
    >
      <TextField autoFocus label="Name" value={fields.name} onChange={(name) => set({ name })} />
      <div className="grid grid-cols-2 items-start gap-2 max-[560px]:grid-cols-1">
        <TextField
          label="Industry"
          value={fields.industry}
          onChange={(industry) => set({ industry })}
        />
        <TextField
          label="Region"
          value={fields.region}
          onChange={(region) => set({ region })}
          hint="Such as UK or EMEA."
        />
      </div>
      <TextArea
        label="Summary"
        value={fields.summary}
        onChange={(summary) => set({ summary })}
        hint="What they want, in a sentence or two."
      />
    </FormDialog>
  )
}

/** A new project in `company` (it starts at Discover), or an edit of `project`. A new one opens on its page. */
export function ProjectDialog({
  company,
  project,
  onClose,
}: {
  company: ProjectScope["company"]
  project?: ProjectRecord
  onClose: () => void
}) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [fields, setFields] = useState(projectFields(project))
  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch })

  async function save() {
    if (project) {
      const patch = projectPatch(project, fields)
      if (Object.keys(patch).length === 0) return null
      const scope = { company, project: project.id }
      return attempt(
        async () => commitProjectChanged(client, scope, await api.updateProject(scope, patch)),
        "project",
      )
    }
    return attempt(async () => {
      const created = await api.createProject(company, projectBody(fields))
      await commitProjectCreated(client, created)
      await navigate({
        to: "/companies/$companyId/projects/$projectId",
        params: { companyId: created.company, projectId: created.id },
      })
    }, "project")
  }

  return (
    <FormDialog
      title={project ? "Edit project" : "New project"}
      description={
        project
          ? "Change the project's name and summary."
          : "Start a project. It begins at Discover."
      }
      save={project ? "Save" : "Create project"}
      validate={() => projectProblem(fields)}
      onSubmit={save}
      onClose={onClose}
    >
      <TextField autoFocus label="Name" value={fields.name} onChange={(name) => set({ name })} />
      <TextArea
        label="Summary"
        value={fields.summary}
        onChange={(summary) => set({ summary })}
        hint="What this piece of work is for."
      />
    </FormDialog>
  )
}
