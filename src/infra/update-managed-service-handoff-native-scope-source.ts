// Embedded into the sealed handoff script; these helpers must not import runtime modules.
export const MANAGED_HANDOFF_NATIVE_SCOPE_SOURCE = String.raw`
async function inspectSystemdService(unit, deadline) {
  const result = await runServiceCommand(
    "systemctl",
    [
      "--user",
      "show",
      unit,
      "--property=Id,LoadState,ActiveState,MainPID,ExecMainStartTimestampMonotonic,InvocationID,FragmentPath",
    ],
    undefined,
    deadline,
  );
  if (result.code !== 0) return null;
  return parseSystemdProperties(result.stdout);
}

`.trim();
