import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

// Diálogo nativo "guardar como". El plugin-dialog concede a fs acceso a la
// ruta elegida, así que no hace falta ampliar el scope en capabilities.
// Devuelve la ruta, o undefined si el usuario cancela.
export async function saveText(
  filename: string,
  text: string,
): Promise<string | undefined> {
  // el filtro sale de la extensión del nombre propuesto: si no, el diálogo
  // ofrece guardar un .csv como .txt
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
