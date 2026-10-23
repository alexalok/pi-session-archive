import fs from "node:fs";
import { dirname, join } from "node:path";

/** Rename normally; on EXDEV, publish a complete destination-side copy first. */
export function movePath(source: string, target: string): void {
	try {
		fs.renameSync(source, target);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
	}

	// Copy into a private temporary directory on the destination filesystem.
	// The final path never exposes a partial copy. A failed copy/publication
	// leaves the source intact; a crash after publication can leave two copies,
	// but cannot leave neither. Preserve directories, symlinks, and timestamps.
	const staging = fs.mkdtempSync(join(dirname(target), ".session-archive-move-"));
	try {
		const copy = join(staging, "entry");
		fs.cpSync(source, copy, {
			recursive: true,
			dereference: false,
			verbatimSymlinks: true,
			preserveTimestamps: true,
			force: false,
			errorOnExist: true,
		});
		fs.renameSync(copy, target);
		fs.rmSync(source, { recursive: true });
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}
