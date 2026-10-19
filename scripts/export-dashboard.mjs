// Build a self-contained static copy of the dashboard (dashboard + current data) into site/ for hosting anywhere.
import fs from "node:fs"; import path from "node:path";
const out = "site"; fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(path.join(out, "data"), { recursive: true });
fs.copyFileSync("dashboard/index.html", path.join(out, "index.html"));
for (const f of ["state.json", "journal.jsonl", "leaders.json"]) if (fs.existsSync(path.join("data", f))) fs.copyFileSync(path.join("data", f), path.join(out, "data", f));
console.log("static site written to site/");
