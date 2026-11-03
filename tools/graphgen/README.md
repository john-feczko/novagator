# Graph generator (floor 3, first pass)

Python scripts that generated `src/data/floor3.graph.json` from the private floor plan
SVG and the Phase 1 field log. Needs Python 3 with numpy, opencv-python and openpyxl.

Run in order from this folder:

    python doors2.py      # find doorways between walkable regions
    python build.py       # corridor centerlines
    python stage2.py      # attach doors, rooms, stairs, elevators
    python export.py      # write floor3.graph.json here
    python fixgaps.py     # bridge small breaks in corridor centerlines
    python check.py stage2.pkl   # connectivity report

Floor 3 is hard-coded for now. Once floor 3 is checked by hand in the editor, the
hand-edited JSON is the source of truth; don't regenerate over it.
