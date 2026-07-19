import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

// Native "save as" dialog. plugin-dialog grants fs access to the chosen
// path, so there is no need to widen the scope in capabilities.
// Returns the path, or undefined if the user cancels.
export async function saveText(
  filename: string,
  text: string,
): Promise<string | undefined> {
  // the filter comes from the extension of the proposed name: otherwise the
  // dialog would offer to save a .csv as .txt
  const ext = filename.split(".").pop()?.toLowerCase() || "txt";
  const path = await save({
    defaultPath: filename,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (!path) return undefined;
  await writeTextFile(path, text);
  return path;
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
