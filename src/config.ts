/**
 * Process-wide runtime settings. Filesystem access (touchstone_path, output_path) is on for local
 * stdio use and off by default for the public HTTP server, where it would expose the host's files.
 */
const state = { filesystem: true };

export function setFilesystemAccess(enabled: boolean): void {
  state.filesystem = enabled;
}

export function filesystemAllowed(): boolean {
  return state.filesystem;
}
