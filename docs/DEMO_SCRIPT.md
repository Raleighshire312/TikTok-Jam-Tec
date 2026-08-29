# AgentTrace Demo Script

Use this script for a short, repeatable Glass Box demo on Saturday, August 29, 2026 or later.

## Successful run

1. Start the app with `npm run dev`.
2. Create an Agent named `Demo Investigator`.
3. Send this prompt:

```text
Create a tiny TypeScript CLI that prints "hello trace", add a minimal test, and run the test.
```

4. Open AgentTrace and show:
   - the success diagnosis
   - the timeline with commands and usage
   - the structured evidence rows
   - the `Export trace` download

## Failing run

1. Send this prompt in the same Agent:

```text
Run cat missing-file-for-demo.txt, explain the failure, and stop after the first failed command.
```

2. In AgentTrace, show:
   - the failure diagnosis headline
   - the highlighted evidence event
   - the non-zero exit code in structured details
   - the filter controls with `Failed only`
   - the `View evidence` jump action

## Redaction proof

1. Send a prompt that contains a mock secret, for example:

```text
Use ARK_API_KEY=test-key while you explain why redaction matters.
```

2. Open the run trace or exported JSON and show that the persisted artifact contains `[REDACTED]` instead of the raw value.
