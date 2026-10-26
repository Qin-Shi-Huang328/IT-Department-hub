# System Integration Contract

The Central Hub makes outbound requests from its server. Store every partner key in the Hub deployment environment; never put API keys in browser HTML or JavaScript.

## Required configuration

Set `STUDENT_RECORDS_API_KEY`, `ENROLLMENT_API_KEY`, `FINANCE_API_KEY`, and `LMS_API_KEY` in the Hub environment. Each value must match the key configured on its corresponding system. Student Records can use the same value as its `API_KEY`.

The administrator dashboard uses the existing Student Records employee login and requires the employee's role to be `admin`. The Hub signs the resulting eight-hour token with `AUTH_SECRET` (or `STUDENT_RECORDS_AUTH_SECRET`). Optional `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_AUTH_SECRET` values can override this flow; if used, keep them private and use a random secret of at least 32 characters.

The old installer distributed the Hub registration key in source. Rotate the Hub's `API_KEY` and update authorized operator environments before using registration again.

Deploy with `npm start`. The Hub uses `DATABASE_URL` (or `HUB_DATABASE_URL`) for its registry. In the current production setup, keep the existing Student Records API as the source of truth and register that API's URL under the `student-records` key. The Hub accesses its records through the API; it does not need a direct database connection for normal operation.

The optional replacement Student Records API is mounted at `/api` on this service and remains disabled until `STUDENT_RECORDS_DATABASE_URL` is configured. Do not register the Hub as its own `student-records` partner unless deliberately migrating. Before any migration, verify a source export and backup; the replacement uses the existing Student Records `salt:hash` scrypt format, but data should not be switched over until login and records have been tested.

Register each deployed system with `POST /hub/register`, sending the Hub's `API_KEY` in the `x-api-key` header and this JSON shape:

```json
{
  "key": "finance",
  "name": "Finance / Transaction",
  "base_url": "https://finance-system.example"
}
```

Supported registration keys are `student-records`, `enrollment`, `finance`, `lms`, and `web-portal`. Registration checks that the system responds to `GET /api/db-check`. If a partner protects its health route, configure its API key in the matching Hub environment variable.

## Data endpoints

- Student Records: `GET /api/students/:id/profile`, `GET /api/students/:id/grades`, `POST /api/auth/login`, and `POST /api/auth/staff-login`.
- Enrollment: `GET /api/students/:id/schedule`.
- Finance: `GET /api/transactions/balance/:studentNo`.
- LMS: `GET /api/students/:id/courses`.

Protected partner endpoints use the `x-api-key` header. Configure the matching key in the Hub's private environment when the partner requires it. The Hub's `/hub/students/:id/full` endpoint gathers these results for the authenticated Web Portal session. The portal's employee search also requires an employee Bearer token.

## Dashboard routes

- `/status` serves the read-only partner health monitor.
- `/dashboard` serves the student and employee portal.
- `/admin` serves the administrator dashboard.
- `/registrar` serves the staff-authenticated, student-only Registrar view.
- `/hub/admin/login` issues a short-lived admin token after server-side credential validation.
- `/hub/admin/*` provides authenticated admin-only proxies for student and employee management. Partner API keys remain on the Hub server.

The optional replacement Student Records API supports:

- `GET /api/students?search=...` to retrieve student identifiers/names and enrollment status.
- `GET /api/students/:id/profile` and `GET /api/students/:id/grades` to retrieve one student's profile and grades.
- `POST /api/students` to create a student account with a password of at least 8 characters.
- `PUT /api/students/:id/grades` to replace that student's full grade list in one transaction. Send an array of up to 500 grade objects with `subject_code` and `subject_name`; an empty array clears the current grade list.
- `GET /api/employees`, `POST /api/employees`, `POST /api/auth/set-staff-password`, and `DELETE /api/employees/:id` for employee management.
- `POST /api/auth/login`, `POST /api/auth/staff-login`, and `GET /api/db-check` for authentication and health checks.

All `/api/*` routes require the Student Records API key in `x-api-key`. Partner systems should call the Hub over HTTPS from their server; do not embed the key in a browser. New replacement passwords are stored as salted scrypt hashes. Grade synchronization is a replacement operation, so callers should send the complete current grade set and verify the response before treating a transfer as complete.

## IT Handoff — Verified Status (2026-10-27)

Share this section with the IT Hub administrator and the system maintainers. Do not include API keys, passwords, or real student records in group messages.

| System | Verified endpoint/status | Required next action |
| --- | --- | --- |
| IT Hub | `https://it-department-hub.onrender.com/` responds. Live `/hub/status` lists Student Records UP, Enrollment UP, and Finance DOWN; LMS and Web Portal are not listed. | Deploy the Hub changes from this workspace before using `/registrar` or registering `web-portal`. Hub changes are local and uncommitted. |
| Student Records | Existing Supabase project has `students`, `grades`, and `employees` tables and data. Its public `/api/db-check` returned HTTP 503 in the last direct check; the Hub's status check has previously reported it UP. | Confirm the Student Records service and database are healthy from its Render deployment. Preserve the existing `salt:hash` scrypt login format. |
| Enrollment | The Hub currently reports Enrollment UP. The supplied contract uses `GET /api/db-check`, `GET /api/students/:studentNumber/schedule`, and `GET /api/students/:studentNumber/status`, with `x-api-key`. | Confirm the registered base URL and that its API key is configured privately in the Hub. |
| Finance | The Hub reports Finance DOWN. The confirmed balance route is `GET /api/transactions/balance/:studentNo`. | Finance maintainer: provide the actual deployed base URL and health route, then confirm the balance response fields. A payment-write endpoint and payload have not been confirmed; do not send payment updates until IT approves that contract. |
| LMS | `https://csfj-lms-api.onrender.com/api/health` and `/api/db-check` returned 404. The public `csfj-lms` repository's `main` branch at `19c24f6` has `/api/db-check` and `/api/students/:id/courses`, but no Render Blueprint, Hub grade-sync route, or `migrate:hub-integration` script. | LMS maintainer: deploy the intended backend with hosted MySQL settings, provide its actual Render URL, and verify `GET /api/db-check` returns 200 before Hub registration. Set any Hub/Student Records API key only in private Render settings. |
| Web Portal | `https://admission-portal-8qdr.onrender.com/api/db-check` returned HTTP 200. Its staff-only student-create flow uses the Student Records API key server-side. | Register as `web-portal` after the Hub change is deployed. The portal's Registrar link should target `https://it-department-hub.onrender.com/registrar` only after that route is live. |

### Safe verification sequence

1. Deploy the Hub changes and verify `/registrar` plus `/hub/status`.
2. Each maintainer supplies their actual base URL, health route, and endpoint contract to the Hub administrator. Share keys privately through Render environment settings only.
3. Register only services whose health check returns HTTP 200; use `student_id` and `student_number` as the same exact identifier string where a system names the field differently.
4. Test with synthetic student data. Verify profile, schedule, balance, and course retrieval. Test payment and grade writes only after the receiving endpoint, authentication, idempotency, and retry behavior are confirmed.
5. Recheck `/hub/status`; do not call the integration complete while any required service is down or unregistered.
