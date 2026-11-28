# VIC Hackathon #1

**Language / Ngôn ngữ:** [English](hackathon.md) | [Tiếng Việt](vi/hackathon.md)

Public page: **https://cloud.synapseone.space/hackathon**

## Overview

VIC Hackathon #1 is a Vietnamese-first product-building event for members of the
VIC Programming Club. Players may register **solo/individually** or as a team of
**2–3 members**, build a product using SynapseOne, then pitch it to the jury. Solo
registration is valid on its own; finding a team beforehand is not required. BTC
may help arrange teammates when requested. Registration does not require a
SynapseOne account.

## Schedule — Vietnam time (UTC+7)

| Milestone | Time |
|---|---|
| Registration closes | **00:00, 29 November 2026** |
| BTC distributes API keys by email | **12:00, 29 November 2026** |
| Pitching round | **19:00, 3 December 2026** |

The public page shows a live countdown to the registration deadline. The server
also enforces the deadline so direct API calls cannot bypass it.

## Rules

1. Players may register solo/individually or as a team of 2–3 members with one
   captain as the contact person. Solo players do not have to find a team before
   registering; BTC may help arrange teammates using the admin suggestions.
2. The product must be developed from SynapseOne, using its APIs, workflows, data
   services or other platform capabilities.
3. Teams must respect copyright, avoid malicious behavior and must not share API
   keys publicly.
4. API keys are created and sent manually by BTC to the captain's registered
   email after approval.
5. Schedule changes are communicated through the registered captain email.

## Prizes

- **First place:** 500,000 VND
- **Second place:** 300,000 VND
- **Third place:** 200,000 VND

Total prize pool: **1,000,000 VND**.

## Jury

The jury is the team that builds and maintains SynapseOne at VKU.VIC:

- Hồ Sỹ Bảo Nhân
- Võ Thành Nam
- Trần Thị Thùy Dương

Team introduction: <https://cloud.synapseone.space/about>

## Registration API

`POST /v1/hackathon/registrations` is public. Required fields:

- `teamName`
- `captainName`
- `captainEmail`
- `captainPhone`
- `captainStudentId`
- `members`: 1–2 additional member names for a team; empty for individual registration
- `memberYears`: one integer 1–5 per person, captain first
- `memberSkills`: one checklist array per person; values are
  `competitive-programming`, `practical-experience`, `product-experience`
- `acceptedRules: true`

Set `registrationType` to `team` or `individual`. Individual registrations omit
`teamName` and `members`.

Optional: `projectIdea`. A hidden `website` honeypot field is rejected when filled.
Team names and captain emails are unique case-insensitively. Public submissions
are rate-limited per IP and capped by `HACKATHON_MAX_REGISTRATIONS` (default 500).

The API returns the registration ID and `pending` status. It never returns an API
key.

## Superadmin workflow

Platform operators and owners can open **Admin → VIC Hackathon** to:

1. Search/filter registrations by team, captain, email, MSV or status.
2. Inspect team members and the optional product idea.
3. Use **Sửa thông tin** to correct the registration type, team name, captain
   contact details, members, years, advanced skills or product idea. Saving uses
   step-up action `hackathon:update`; approval, review notes and API-key delivery
   timestamps are preserved. A warning appears when changing an email that was
   already marked as sent.
4. Approve or reject with a fresh step-up proof (`hackathon:review`).
5. Create the API key through the normal trusted operator process and email it
   manually to the captain.
6. Open **Gợi ý ghép team** to see non-mutating suggestions for individual players.
   The algorithm anchors each suggested trio with a second-year student or someone
   with advanced skills, then prefers two first-year students.
7. Mark the registration as sent with step-up action
   `hackathon:api-key-sent`.

Auditors are read-only. Detail edits, review and delivery actions are audited. The
system stores only delivery status/timestamps, never plaintext API keys.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HACKATHON_REGISTRATION_CLOSE_AT` | `2026-11-28T17:00:00.000Z` | Server-side deadline; ISO timestamp. |
| `HACKATHON_MAX_REGISTRATIONS` | `500` | Maximum number of registrations (solo and teams). |
| `HACKATHON_REGISTRATION_RATE_LIMIT` | `5` | Public submissions allowed per IP/window. |
| `HACKATHON_REGISTRATION_RATE_WINDOW_MS` | `900000` | Rate-limit window (15 minutes). |

The default deadline is 00:00 Vietnam time on 29 November 2026. Keep the public
page schedule and the server variable in sync when changing the event date.

## Privacy and security

- Registration is intentionally anonymous; no tenant identity is attached.
- Contact details are visible only to authorized platform administrators.
- Mutations require platform operator/owner, step-up when enabled, and audit.
- Do not paste API keys into review notes or registration records.
- Back up the `hackathon_registrations` table before schema/data maintenance.
