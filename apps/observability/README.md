# Observability

One clean folder that a rig boots into a working, agent-managed observability
stack. An infra seat holds a bounded Grafana + Prometheus + node-exporter stack;
an observer agent seat deploys it, watches it, and explains — in plain English —
how the box is doing right now, honest about every unknown and every failure.

## What the dashboard shows

Four honest categories, one dark board:

- System — CPU busy, memory used, disk used, from node-exporter reading the real guest /proc, /sys, and rootfs (read-only mounts, unprivileged).
- Networking — receive and transmit rates, from node-exporter.
- Visitor activity — read-only from the box's access-visitors log (one email + first-seen per line); never modified.
- Provider auth / rate-limit — read-only from the provider watcher's durable state. When that source is missing or unavailable the panel reads UNKNOWN — never a fabricated healthy zero.

## The three verbs

```
node obs.mjs deploy      boot only this bounded stack (disposable guest only)
node obs.mjs watch       report current stack + source + metric health
node obs.mjs explain     plain-English "how is the box doing right now?"
```

## Honest data contract

The adapter transforms the read-only JSONL sources into an owned Prometheus
textfile (box_visitor_ and box_provider_ metrics) and never modifies the
sources. It records source path, source mtime, parse time, and newest-event
time. A missing, malformed, or unavailable source is reported as unavailable
(source-available 0), and a real provider failure always outranks an incidental
unknown.

## Install (drift-aware, no destructive action)

The stack runs in your disposable guest only — never on the shared host. Compare
the canonical installed source at ~/studio/apps/observability against the box's
deployed stack, and repair (copy the canonical source in) only if the box stack
is missing, provably broken, or provably older. If the box stack is newer
(forward drift), leave it untouched and report. If age or health is ambiguous,
leave it untouched and report to the box lead agent.
