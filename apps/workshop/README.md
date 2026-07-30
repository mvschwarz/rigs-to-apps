# Workshop

Open one scene and refine it with an agent beside you: key, mix, versions,
health, all live. Duplicate a version and switch freely — switching destroys
nothing. Ask the agent to Suggest, Match keys, or Match space; the brief lands in
its session and you watch it work in the panel. The focused half of
music-making: not the whole library, just this one scene, made right.

## What you get

One folder — the workshop surface plus the engineer-agent's agentspec. It runs
in the studio shell with the agent sidebar.

## How it runs

The workshop surface mounts inside the studio shell; the engineer-agent is the
shell's sidebar, driven by the workshop's own Suggest / Match actions (each lands
a brief in the agent's session). The agent backend runs on the box, not in this
package.

## Install (drift-aware, no destructive action)

Compare the canonical installed source at ~/studio/apps/workshop against the
box's served surface, and repair (copy the canonical source in) only if the box
surface is missing, provably broken, or provably older. If the box surface is
newer (forward drift), leave it untouched and report. If age or health is
ambiguous, leave it untouched and report to the box lead agent.
