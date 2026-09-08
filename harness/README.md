# Feedback harness

The custom rehearsal suite lives here. Application code stays in `apps/`;
deployment, migration and ordinary repository tooling stays in `scripts/`.

- `feedback/`: deterministic feedback scenarios and shared in-memory doubles.
- `*.mjs`: burst/simulator clients, bounded data inspection/reset, reports and
  their offline tests.
- `fixtures/workshop-feedback/`: authored synthetic conversations and their
  deterministic projections.

Use the root commands from the repository root:

| Command                                | Runs                                                                |
| -------------------------------------- | ------------------------------------------------------------------- |
| `pnpm test`                            | Workspace tests, including harness scenarios and offline tool tests |
| `pnpm --filter @slopform/harness test` | Only this suite, after building the database/backend                |
| `pnpm typecheck`                       | Application and harness types                                       |
| `pnpm test:workshop-scenarios`         | Fixture consistency, without model calls                            |
| `pnpm test:feedback:postgres`          | Real database scenarios against `FEEDBACK_POSTGRES_TEST_URL`        |
| `pnpm feedback:simulate -- --help`     | Simulator client options                                            |
| `pnpm feedback:burst -- --help`        | Burst rehearsal options                                             |
| `pnpm feedback:burst:answers`          | Compare recorded answers with fixture expectations                  |
| `pnpm feedback:burst:transcript`       | Inspect the recorded transcript                                     |
| `pnpm feedback:burst:reset -- --help`  | Bounded cleanup options                                             |

Ordinary tests do not start a live rehearsal. Commands targeting an API or
database keep their explicit target, fixture scope and existing confirmation
flags. Real-provider runs are separate from `pnpm check`. Output belongs under
the ignored root `report/` directory.

Add tests for behavior that matters: delivery uncertainty, state transitions,
idempotency, recovery and participant interactions. Do not add assertions about
source text or internal class wiring. The in-memory scenarios do not prove SQL
locking; the disposable PostgreSQL suite covers that boundary.
