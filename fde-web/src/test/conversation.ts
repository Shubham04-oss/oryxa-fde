import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Answers the new-company conversation the way a person would, for the tests of its screen.

export const conversation = () => screen.getByRole("region", { name: "Conversation" })
export const question = (name: string) => screen.findByRole("heading", { name })
export const press = (name: string) =>
  userEvent.click(within(conversation()).getByRole("button", { name, exact: true } as never))

/** Answers the conversation up to the plan step; `name` is typed as the company's name. */
export async function toPlan(name = "Orion Rail") {
  await userEvent.type(await screen.findByLabelText("Company name"), name)
  await userEvent.type(screen.getByLabelText("First project"), "Claims intake")
  await userEvent.type(screen.getByLabelText("What are you delivering?"), "Claims intake.")
  await press("Continue")
  await question("How do you want to start?")
  await userEvent.type(screen.getByLabelText("Main contact at the company"), "Dana Ortiz")
  await userEvent.type(
    screen.getByLabelText("What would show it worked?"),
    "Claims triaged in two hours",
  )
  await userEvent.type(screen.getByLabelText("What is measured"), "hours to triage")
  await userEvent.selectOptions(screen.getByLabelText("It passes when it is"), "at_most")
  await userEvent.type(screen.getByLabelText("Target"), "2")
  await userEvent.type(screen.getByLabelText("Unit"), "h")
  await press("Add a baseline and how it will be proven")
  await userEvent.type(screen.getByLabelText("Baseline"), "9")
  await press("Continue")
  await question("What may agents do here, and who approves?")
  await press("Continue")
  await question("Who should be invited?")
  await userEvent.type(screen.getByLabelText("Email of person 1"), "sam@example.com")
  await press("Continue")
  await question("Here is a plan to start with. Change anything.")
}

/** Answers every step and opens the review. */
export async function toReview(name = "Orion Rail") {
  await toPlan(name)
  await press("Use this plan")
  await question(`Ready to create ${name}?`)
}

/** The review's list of what Create company saves. */
export const savedList = () =>
  within(conversation()).getByRole("region", { name: "Saved when you create it" })
