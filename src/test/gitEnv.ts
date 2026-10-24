/** Keep fixture Git commands independent of the invoking shell's repository. */
export function gitFixtureEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_GRAFT_FILE',
    'GIT_SHALLOW_FILE',
    'GIT_PREFIX',
  ]) {
    delete env[key]
  }
  return env
}
