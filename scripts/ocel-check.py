"""Read an OCEL 2.0 JSON export back with pm4py — the conformance gate outside this codebase.

    python3 -m venv .venv-ocel && .venv-ocel/bin/pip install pm4py     # once; gitignored
    node scripts/export-ocel.mjs F1 --out /tmp/F1.ocel.json
    .venv-ocel/bin/python scripts/ocel-check.py /tmp/F1.ocel.json

What it proves: the file is a log the reference library accepts as OCEL 2.0 — it parses,
and its counts of objects, events, object types, event types and E2O rows equal the file's.
It then discovers pm4py's object-centric DFG from the log and prints, per object type, the
activities and the directly-follows pairs it found, so the export can be read against the
tool's own process map for the same objects. Anything the export writes that pm4py drops
would show here as a count that does not match.

Exit status 0 when every count matches, 1 otherwise, 2 when pm4py is not importable.
"""

import json
import sys


def main(path):
    try:
        import pm4py  # noqa: F401  — the venv recipe above
    except ImportError:
        print("pm4py is not importable; create the venv the docstring describes", file=sys.stderr)
        return 2

    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    ocel = pm4py.read_ocel2_json(path)

    problems = []

    def expect(name, got, want):
        flag = "ok " if got == want else "BAD"
        print(f"{flag} {name}: pm4py {got}, file {want}")
        if got != want:
            problems.append(name)

    expect("objects", len(ocel.objects), len(raw["objects"]))
    expect("events", len(ocel.events), len(raw["events"]))
    expect("object types", ocel.objects[ocel.object_type_column].nunique(), len(raw["objectTypes"]))
    expect("event types", ocel.events[ocel.event_activity].nunique(), len(raw["eventTypes"]))
    expect(
        "E2O rows",
        len(ocel.relations),
        sum(len(e.get("relationships", [])) for e in raw["events"]),
    )
    o2o_file = sum(len(o.get("relationships", [])) for o in raw["objects"])
    if ocel.o2o is not None:
        expect("O2O rows", len(ocel.o2o), o2o_file)
    else:
        print(f"--  O2O rows: pm4py exposes none, file {o2o_file}")

    # The reference library's own object-centric DFG over the same log, so the tool's
    # process map can be read against it for a sub-log.
    try:
        ocdfg = pm4py.discover_ocdfg(ocel)
        by_type = ocdfg["activities_ot"]["events"]      # object type → {activity: {event ids}}
        couples = ocdfg["edges"]["event_couples"]        # object type → {(from, to): {(e1, e2)}}
        for object_type in sorted(by_type):
            activities = by_type[object_type]
            edges = couples.get(object_type, {})
            pairs = ", ".join(f"{a}→{b} ×{len(ids)}" for (a, b), ids in sorted(edges.items()))
            print(f"    {object_type}: {len(activities)} activities; {len(edges)} directly-follows pairs: {pairs}")
    except Exception as error:  # pm4py's discovery API has moved between versions
        print(f"--  OC-DFG discovery skipped: {error}")

    print("PASS" if not problems else f"FAIL: {', '.join(problems)}")
    return 0 if not problems else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: ocel-check.py <log.json>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
