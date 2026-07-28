# Candidate Profile and Application Policy

`config/candidate-profile.json` is the canonical source of candidate facts.
`config/application-policy.json` contains writing and delivery preferences. A
workflow must not treat the application policy as evidence of a skill,
achievement, project, metric, availability commitment, or salary expectation.

## Versioning

- `profile_version` identifies the resume snapshot used for discovery,
  evaluation, and generation.
- `candidate_profile_version` in the application policy must equal the active
  profile version.
- Evaluations store `profile_version`.
- Generated messages store `message_profile_version`.
- Activating a new profile does not rewrite historical evaluations or messages.

The profile validator rejects unsupported schema versions, malformed links,
missing required sections, obsolete resume content, and policy references to
unknown links or projects.

## Approved candidate content

Only facts represented in the candidate profile may be used as candidate
evidence. The current approved candidate URLs are the LinkedIn, GitHub, and
portfolio links in `candidate.links`, plus project URLs attached to canonical
projects. There is no approved resume-PDF URL, phone number, salary expectation,
or availability commitment.

The current project list is:

- Rent N Roll
- Job Pipeline

The current profile intentionally excludes the obsolete Netlify portfolio and
the FireCheck, HEALTH, and PriceCraft project claims embedded in the legacy
generator prompt.

## Updating the profile

1. Copy the current configuration files to a recoverable backup.
2. Update factual resume content in `config/candidate-profile.json`.
3. Increment `profile_version` using an ISO date.
4. Update `candidate_profile_version` in the application policy.
5. Run `npm run build` and `npm run validate`.
6. Review the resulting search plan and generated-message policy before
   activating updated workflows.

Do not put unverified placeholders into the profile. Unknown expected
graduation dates, metrics, salary preferences, or work schedules remain absent
until explicitly approved.

## Privacy boundary

The repository is public. Add only contact details already approved for public
applications. Credentials, access tokens, private documents, and unapproved
personal data do not belong in profile or policy files, workflow exports,
fixtures, error messages, or logs.
