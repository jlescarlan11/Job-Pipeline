# Candidate Profile and Application Policy

The visible Google Sheet context tabs are the production runtime source of
candidate facts and editable preferences. `config/candidate-profile.json`,
`config/ranking-policy.json`, and `config/application-policy.json` provide the
reviewed bootstrap values used only when provisioning a new workbook. A
workflow must not treat the application policy as evidence of a skill,
achievement, project, metric, availability commitment, or salary expectation.

## Versioning

- A deterministic `sheet/<context-hash>` identifies each normalized candidate,
  ranking-preference, and application-preference snapshot.
- Operators never edit version fields; changing context changes the hash.
- Evaluations store `profile_version`.
- Generated messages store `message_profile_version`.
- Activating a new profile does not rewrite historical evaluations or messages.

The profile validator rejects unsupported schema versions, malformed links,
missing required sections, unresolved bracketed resume placeholders, duplicate
project technologies, and policy references to unknown links or projects.

## Approved candidate content

Only facts represented in the candidate profile may be used as candidate
evidence. The current approved candidate URLs are the LinkedIn, GitHub, and
portfolio links in `candidate.links`, plus project URLs attached to canonical
projects. There is no approved resume-PDF URL, phone number, salary expectation,
or availability commitment.

The current project list is:

- Rent N Roll
- Job Pipeline

The bootstrap `Banned Phrases` rows ban obsolete project claims from the legacy
generator prompt. Operators can review or change those exclusions in the Sheet
without rebuilding a workflow.

## Updating runtime context

1. Edit the appropriate `Candidate`, `Skills`, `Experience`, `Projects`,
   `Education`, `Awards`, `Job Preferences`, `Application Settings`, `Required
   Style`, or `Banned Phrases` tab.
2. Keep stable experience/project IDs when editing an existing entity. Use one
   row per highlight and repeat the entity metadata exactly.
3. Enable or disable list rows with the checkbox instead of deleting facts you
   may want to restore.
4. Let the next scheduled Generator or Alerter & Mover execution validate and
   freeze the new snapshot. No workflow rebuild, import, or activation is
   required.

Repository bootstrap files change only when the default content for a future
new workbook should also change. Such a repository change still requires the
normal build and validation process.

Do not put unverified placeholders into the profile. Unknown expected
graduation dates, metrics, salary preferences, or work schedules remain absent
until explicitly approved.

Activating a new profile intentionally makes older message and application-pack
provenance stale. Do not rewrite those historical version fields. The shared
message-safety gate suppresses stale messages from alerts until the job is
regenerated under the active profile. It does not discard an `I Applied`
action, which records a manual application that already happened. Preserve
existing messages, application snapshots, decisions, outcomes, and Archive
history during rollout.

## Privacy boundary

The repository is public. Add only contact details already approved for public
applications. Credentials, access tokens, private documents, and unapproved
personal data do not belong in profile or policy files, workflow exports,
fixtures, error messages, or logs.
