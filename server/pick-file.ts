import { execFile } from "node:child_process";

const PROMPT = "Choose a DuckDB database or write-ahead log";

/** Each platform's open-file dialog, as a command that prints the chosen path and exits non-zero when cancelled. */
const DIALOGS: Partial<Record<NodeJS.Platform, [string, string[]][]>> = {
  darwin: [["osascript", ["-e", "activate", "-e", `POSIX path of (choose file with prompt "${PROMPT}")`]]],
  linux: [
    ["zenity", ["--file-selection", `--title=${PROMPT}`]],
    ["kdialog", ["--getopenfilename", ".", "", "--title", PROMPT]],
  ],
  win32: [
    [
      "powershell",
      [
        "-NoProfile",
        "-STA",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; " +
          `$d.Title = '${PROMPT}'; if ($d.ShowDialog() -eq 'OK') { $d.FileName } else { exit 1 }`,
      ],
    ],
  ],
};

type Outcome = { path: string | null } | { missing: true };

function run(command: string, args: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") resolve({ missing: true });
      else resolve({ path: error ? null : stdout.trim() || null });
    });
  });
}

/** Shows the system's open-file dialog: the chosen path, null when cancelled, undefined when there is no dialog. */
export async function pickFile(): Promise<string | null | undefined> {
  for (const [command, args] of DIALOGS[process.platform] ?? []) {
    const outcome = await run(command, args);
    if (!("missing" in outcome)) return outcome.path;
  }
  return undefined;
}
