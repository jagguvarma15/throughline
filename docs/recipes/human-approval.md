# Recipe: durable human (or agent) approval

A run that needs sign-off should not depend on a process staying alive. With
`ctx.waitForApproval`, the run parks in the database and survives redeploys, restarts,
and weekends.

## In the task

```ts
tf.task("publish-report", async (ctx, input: { draft: string }) => {
  const report = await ctx.step("polish", () => polish(input.draft));

  // Parks the run (status: waiting) until someone signals "publish".
  // An optional timeout turns silence into a TimeoutError branch.
  const approved = await ctx.waitForApproval("publish", { timeout: "3d" });

  if (!approved) return { published: false };
  await ctx.step("publish", () => publish(report));
  return { published: true };
});
```

The wait is journal-first: once approved, a later replay returns the journaled decision
without re-consuming anything, and a decision cannot flip after a timeout is taken.

## Resolving the gate

Any ops surface can deliver the approval:

```ts
await tf.signal(id, "publish", { approved: true });        // in-process
```

```bash
throughline approve <id> publish                            # CLI (--deny to reject)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"publish","payload":{"approved":true}}' \
  -H "content-type: application/json" $CP/runs/<id>/signal  # HTTP
```

Claude or any MCP host can do the same with the `approve_run` tool, and the dashboard
shows waiting runs under Approvals with Approve/Reject buttons.

## Waiting for arbitrary events

`waitForApproval` is sugar over `ctx.waitForEvent(name)`, which returns the full signal
payload - use it for form input, webhook callbacks, or another agent's output:

```ts
const reply = await ctx.waitForEvent<{ text: string }>("user-reply", { timeout: "1h" });
```
